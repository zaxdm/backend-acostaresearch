'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const { ERROR_CODES } = require('../../config/constants');
const { AppError } = require('../../shared/errors/AppError');
const { generarConRespaldo, modelosDeTexto, GeminiError } = require('../../lib/gemini');
const billingService = require('../billing/billing.service');
const discountService = require('../billing/discount.service');
const { construirSistema } = require('./asistente.prompt');
const { crearTopeDiario } = require('./asistente.tope');

/**
 * El Asistente Acosta: responde a quien entra a la web.
 *
 * NO GUARDA NADA. Ni la conversación ni quién la tuvo: la historia llega
 * entera desde el navegador, se manda a Gemini y se olvida. En el log solo
 * queda cuánto gastó cada respuesta, nunca lo que se dijo.
 */

/**
 * Los precios se leen de la base, pero no en cada mensaje.
 *
 * La base aguanta cinco conexiones y una conversación son diez mensajes: sin
 * esta memoria, un rato con cuatro visitantes charlando se notaría en el resto
 * de la web. Diez minutos es lo que tarda en verse un precio cambiado desde el
 * panel, que es un retraso aceptable para una charla.
 */
const PLANES_VIGENCIA_MS = 10 * 60 * 1000;
let planesEnMemoria = { valor: null, leidoEn: 0 };

/**
 * Los planes y las promociones públicas, con la misma memoria de diez minutos.
 *
 * Las promociones van juntas porque la página de precios las aplica solas: un
 * precio sin su promoción es un precio que la persona no va a ver.
 */
async function preciosVigentes() {
  if (planesEnMemoria.valor && Date.now() - planesEnMemoria.leidoEn < PLANES_VIGENCIA_MS) {
    return planesEnMemoria.valor;
  }

  try {
    // Una detrás de otra y no a la vez: la base aguanta cinco conexiones.
    const planes = await billingService.listPlans();
    const promos = await discountService.publicos();
    planesEnMemoria = { valor: { planes, promos }, leidoEn: Date.now() };
    return planesEnMemoria.valor;
  } catch (error) {
    // Con la base caída el asistente sigue atendiendo: las dudas no necesitan
    // precios, y el prompt ya le dice que no dé cifras si no las tiene.
    logger.warn({ err: error }, 'Asistente: no se pudieron leer los planes');
    return planesEnMemoria.valor ?? { planes: [], promos: [] };
  }
}

const tope = crearTopeDiario(env.ASISTENTE_MAX_DIARIO);

/**
 * Cuando Gemini se niega por sus filtros. No es un error del visitante ni del
 * servicio, así que se le contesta como un mensaje más y no con un fallo.
 */
const RESPUESTA_BLOQUEADA =
  'Esa pregunta no la puedo responder por aquí. Si es sobre tu tesis o sobre lo que ofrecemos, ' +
  'pregúntamelo de otra forma, o escríbenos por [WhatsApp](whatsapp) y te atiende una persona.';

const noDisponible = (message) =>
  new AppError(message, { statusCode: 503, code: ERROR_CODES.ASSISTANT_UNAVAILABLE });

const asistenteService = {
  estado() {
    return { activo: env.asistenteEnabled };
  },

  async responder({ mensajes, pagina, conSesion }) {
    if (!env.asistenteEnabled) {
      throw noDisponible('El asistente no está disponible. Escríbenos por WhatsApp.');
    }

    if (!tope.intentar()) {
      logger.warn({ tope: env.ASISTENTE_MAX_DIARIO }, 'Asistente: tope diario alcanzado');
      throw noDisponible(
        'El asistente ya atendió muchas consultas hoy. Escríbenos por WhatsApp y te respondemos.',
      );
    }

    const { planes, promos } = await preciosVigentes();
    const sistema = construirSistema({ planes, promos, pagina, conSesion });

    try {
      const { texto, finishReason, uso, modelo } = await generarConRespaldo({
        modelos: modelosDeTexto(),
        sistema,
        mensajes,
        // Pasados cinco segundos sin respuesta, se pregunta también al siguiente.
        ventajaMs: 5_000,
      });
      logger.info(
        {
          modelo,
          finishReason,
          entrada: uso?.promptTokenCount,
          cache: uso?.cachedContentTokenCount,
          salida: uso?.candidatesTokenCount,
          pensamiento: uso?.thoughtsTokenCount,
          mensajesHoy: tope.usados(),
        },
        'Asistente: respuesta',
      );
      return { respuesta: texto };
    } catch (error) {
      if (error instanceof GeminiError && error.bloqueado) {
        logger.warn({ motivo: error.message }, 'Asistente: Gemini bloqueó la respuesta');
        return { respuesta: RESPUESTA_BLOQUEADA };
      }

      logger.error({ err: error }, 'Asistente: Gemini falló');
      throw noDisponible(
        'El asistente no pudo responder ahora. Inténtalo en un momento o escríbenos por WhatsApp.',
      );
    }
  },
};

module.exports = asistenteService;

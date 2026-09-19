'use strict';

const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const { ERROR_CODES } = require('../config/constants');
const { ipCliente } = require('../shared/utils/ipCliente');

/**
 * Por persona cuando hay sesión, y por IP si no.
 *
 * Para las rutas que ya pasaron por `authenticate`: detrás de la misma IP de un
 * operador o de la wifi de una universidad hay muchos tesistas, y no tiene
 * sentido que el botón de uno se gaste con los clics de otro.
 */
const porUsuario = (req) => (req.user?.id ? `usuario:${req.user.id}` : ipCliente(req));

function build({ windowMs, max, message, keyGenerator = ipCliente }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // La del visitante y no la de Cloudflare: ver `ipCliente`.
    keyGenerator,
    // En desarrollo estorba más de lo que protege.
    skip: () => env.isDevelopment,
    handler: (_req, res) =>
      res.status(429).json({
        success: false,
        error: { code: ERROR_CODES.TOO_MANY_REQUESTS, message },
      }),
  });
}

/** Límite general de la API. */
const globalLimiter = build({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: 'Demasiadas peticiones. Inténtalo de nuevo en unos minutos.',
});

/**
 * Límite para los endpoints que se prestan a fuerza bruta.
 *
 * Treinta por cuarto de hora y por IP. No son treinta por persona: en Perú es
 * habitual que un operador saque a muchos abonados por la misma IP pública, así
 * que un número bajo aquí bloquea a gente que no ha hecho nada. Diez se quedaba
 * corto incluso para una sola persona que se equivoque al teclear.
 */
const authLimiter = build({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Demasiados intentos. Espera unos minutos antes de volver a intentarlo.',
});

/** Límite para reenvío de correos, que además cuesta dinero. */
const emailLimiter = build({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Has solicitado demasiados correos. Inténtalo más tarde.',
});

/** Cada reescritura es una llamada de pago: se frena el abuso por ráfagas. */
const rewriteLimiter = build({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Estás enviando reescrituras demasiado rápido. Espera un momento.',
});

/** Abrir órdenes de pago es barato para nosotros, pero ensucia la pasarela. */
const paymentLimiter = build({
  windowMs: 10 * 60 * 1000,
  max: 15,
  message: 'Has abierto demasiados pagos seguidos. Espera unos minutos.',
});

/**
 * Traerse la biblioteca de Zotero a mano.
 *
 * Cada pulsación son varias peticiones a api.zotero.org con la clave de ese
 * tesista. Zotero frena por cuenta —y nos manda `Backoff`, que se respeta— pero
 * la aplicación registrada es una sola y es nuestra: quien se ponga a pulsar
 * «actualizar» nos gasta la reputación a todos. De todas formas se sincroniza
 * sola cada noche, así que este botón es para el impaciente, no para el uso
 * normal.
 */
const zoteroSyncLimiter = build({
  windowMs: 10 * 60 * 1000,
  max: 6,
  message: 'Has pedido tu biblioteca varias veces seguidas. Espera unos minutos.',
  keyGenerator: porUsuario,
});

/**
 * Conectar Zotero y ver la lista de colecciones.
 *
 * Aparte del de sincronizar, y más holgado. Antes compartían los seis del de
 * arriba, y la lista de colecciones se pide sola al volver de zotero.org y al
 * entrar en el buscador: quien reintentaba un par de veces se encontraba
 * «Conectar Zotero» respondiendo 429 sin haber traído nada. Ninguna de las dos
 * descarga la biblioteca: una pide un token y la otra, la lista de carpetas.
 */
const zoteroConectarLimiter = build({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: 'Has intentado conectar Zotero muchas veces seguidas. Espera unos minutos.',
  keyGenerator: porUsuario,
});

/**
 * Buscar e importar desde la API de Scopus.
 *
 * Cada búsqueda es una petición a api.elsevier.com con la clave de la casa, y
 * esa clave tiene CUOTA SEMANAL: unos miles de peticiones para todos los
 * compradores juntos. No es como OpenAlex, que se recupera a medianoche; aquí
 * quien se ponga a paginar sin mirar deja sin buscador a los demás durante
 * días.
 *
 * Treinta cada diez minutos y POR PERSONA: son más de las que pasa alguien
 * revisando resultados de verdad, y no se gastan entre tesistas que comparten
 * la IP de una universidad. El importar va por el mismo cubo porque también es
 * una petición a Elsevier.
 */
const scopusBuscarLimiter = build({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: 'Has buscado en Scopus muchas veces seguidas. Espera unos minutos.',
  keyGenerator: porUsuario,
});

/**
 * La IA del buscador de Scopus: el generador de consultas y el resumen con
 * citas, con sus preguntas de seguimiento.
 *
 * Cada uso es una llamada a Gemini, que se paga. Veinte cada diez minutos por
 * persona, entre las dos cosas: sobra para afinar el tema, buscar, leer el
 * resumen y hacer unas cuantas preguntas, y corta a quien lo use de chat.
 */
const scopusIaLimiter = build({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: 'Has usado la IA del buscador muchas veces seguidas. Espera unos minutos.',
  keyGenerator: porUsuario,
});

/**
 * Conectar y desconectar Scopus.
 *
 * Aparte del de buscar y más holgado, por lo mismo que en Zotero: conectar no
 * consulta el catálogo, y quien reintenta un par de veces no puede encontrarse
 * el botón respondiendo 429 sin haber traído nada.
 */
const scopusConectarLimiter = build({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: 'Has intentado conectar Scopus muchas veces seguidas. Espera unos minutos.',
  keyGenerator: porUsuario,
});

/**
 * Recoger un conector de un enlace de prueba.
 *
 * Holgado a propósito: un taller entero sale a internet por la wifi de la
 * universidad, con UNA sola IP, y los treinta pulsan en el mismo minuto. Esto no
 * protege los cupos —de eso se ocupa el tope del enlace—, solo frena a un script
 * que vacíe enlaces a ráfagas.
 */
const trialClaimLimiter = build({
  windowMs: 10 * 60 * 1000,
  max: 60,
  message: 'Se han pedido demasiados conectores desde esta conexión. Espera unos minutos.',
});

/**
 * Mensajes al Asistente Acosta.
 *
 * Cuarenta cada diez minutos es más de lo que escribe una persona charlando, y
 * deja sitio a varias detrás de la misma IP de operador. La factura no la
 * protege esto sino el tope diario del servicio.
 */
const asistenteLimiter = build({
  windowMs: 10 * 60 * 1000,
  max: 40,
  message: 'Estás escribiendo muy rápido. Espera unos minutos o escríbenos por WhatsApp.',
});

/**
 * Hojas del Libro de Reclamaciones.
 *
 * Diez por hora es más de lo que presenta una persona con motivo, y deja sitio a
 * varias detrás de la misma IP de operador. Cada hoja manda dos correos y ocupa
 * un número del libro que ya no se puede borrar: sin freno, un script llenaría
 * el libro de basura con numeración legal.
 */
const reclamoLimiter = build({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Has enviado varias hojas seguidas. Si falta algo, escríbenos por WhatsApp.',
});

/**
 * Límite del conector MCP, contado POR LICENCIA y no por IP.
 *
 * Es obligatorio que sea así: Claude llama desde la infraestructura de
 * Anthropic, de modo que todos los compradores llegan con la misma dirección.
 * Un límite por IP los metería a todos en el mismo cubo y el primero que
 * trabajara mucho dejaría fuera a los demás.
 */
const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.params.token ?? 'sin-token',
  skip: () => env.isDevelopment,
  handler: (_req, res) =>
    res.status(429).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Demasiadas consultas seguidas. Espera un momento.' },
      id: null,
    }),
});

/**
 * Llamadas al conector que FALLAN, por IP.
 *
 * Una licencia inventada no se puede contar por licencia —cada intento estrena
 * la suya—, y cada una costaba una consulta a una base de cinco conexiones. Se
 * cuentan solo los fallos, y con mucho margen: todos los compradores llegan
 * desde las IP de Anthropic, y los de licencia caducada siguen llamando.
 */
const mcpFallosLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 300,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: ipCliente,
  skip: () => env.isDevelopment,
  handler: (_req, res) =>
    res.status(429).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Demasiadas consultas con licencias que no valen. Espera unos minutos.' },
      id: null,
    }),
});

module.exports = {
  mcpFallosLimiter,
  globalLimiter,
  authLimiter,
  emailLimiter,
  rewriteLimiter,
  paymentLimiter,
  trialClaimLimiter,
  zoteroSyncLimiter,
  zoteroConectarLimiter,
  scopusBuscarLimiter,
  scopusConectarLimiter,
  scopusIaLimiter,
  asistenteLimiter,
  reclamoLimiter,
  mcpLimiter,
};

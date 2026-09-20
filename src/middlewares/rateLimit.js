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

/**
 * Cuánto falta para poder volver a intentarlo, dicho en cristiano.
 *
 * «Espera unos minutos» no le sirve a nadie: con un cubo de diez minutos, el
 * que espera uno vuelve a chocar y el que espera diez esperó de más sin saber
 * si el problema era otro. La hora de reinicio la lleva el propio limitador,
 * así que se dice el número.
 */
function cuantoFalta(reinicio) {
  const faltan = reinicio instanceof Date ? reinicio.getTime() - Date.now() : NaN;
  if (!Number.isFinite(faltan) || faltan <= 0) return 'Vuelve a intentarlo en un momento.';
  if (faltan < 60_000) return `Vuelve a intentarlo en ${Math.ceil(faltan / 1000)} segundos.`;

  const minutos = Math.ceil(faltan / 60_000);
  return `Vuelve a intentarlo en ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}.`;
}

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
    handler: (req, res) =>
      res.status(429).json({
        success: false,
        error: {
          code: ERROR_CODES.TOO_MANY_REQUESTS,
          message: `${message} ${cuantoFalta(req.rateLimit?.resetTime)}`,
        },
      }),
  });
}

/** Límite general de la API. */
const globalLimiter = build({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: 'Demasiadas peticiones.',
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
  message: 'Demasiados intentos.',
});

/** Límite para reenvío de correos, que además cuesta dinero. */
const emailLimiter = build({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Has solicitado demasiados correos.',
});

/** Cada reescritura es una llamada de pago: se frena el abuso por ráfagas. */
const rewriteLimiter = build({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Estás enviando reescrituras demasiado rápido.',
});

/** Abrir órdenes de pago es barato para nosotros, pero ensucia la pasarela. */
const paymentLimiter = build({
  windowMs: 10 * 60 * 1000,
  max: 15,
  message: 'Has abierto demasiados pagos seguidos.',
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
  message: 'Has pedido tu biblioteca varias veces seguidas.',
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
  message: 'Has intentado conectar Zotero muchas veces seguidas.',
  keyGenerator: porUsuario,
});

/**
 * Los mismos dos de arriba, para Mendeley. Contadores propios: el limitador
 * cuenta por usuario y no por ruta, así que compartir los de Zotero haría que
 * quien conecta los dos gastara el cupo de uno con el otro, y el aviso diría
 * «Zotero» a quien estaba en Mendeley.
 */
const mendeleySyncLimiter = build({
  windowMs: 10 * 60 * 1000,
  max: 6,
  message: 'Has pedido tu biblioteca de Mendeley varias veces seguidas.',
  keyGenerator: porUsuario,
});

const mendeleyConectarLimiter = build({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: 'Has intentado conectar Mendeley muchas veces seguidas.',
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
  message: 'Has buscado en Scopus muchas veces seguidas.',
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
  message: 'Has usado la IA del buscador muchas veces seguidas.',
  keyGenerator: porUsuario,
});

/**
 * Ordenar por significado, que es otra cosa y por eso tiene su propio cubo.
 *
 * Compartía los veinte de arriba, y desde que el copiloto propone tarjetas de
 * temas cada una se busca ordenada por significado: mirar cuatro temas son
 * cuatro, más la propuesta, más un resumen por búsqueda. El tesista se quedaba
 * sin poder pedir el resumen de lo que acababa de encontrar por haber mirado
 * sus propios temas, que es justo lo que le pedimos que haga.
 *
 * Y no gasta lo mismo: esto son vectores del plan gratuito de Gemini —con su
 * propio tope por minuto, que ya avisa aparte— y no texto generado, que es lo
 * que se paga. Cuarenta cada diez minutos por persona.
 */
const scopusSemanticaLimiter = build({
  windowMs: 10 * 60 * 1000,
  max: 40,
  message: 'Has ordenado por significado muchas veces seguidas.',
  keyGenerator: porUsuario,
});

/**
 * Los números de los filtros del buscador de Scopus.
 *
 * Abrir una sección con números exactos son hasta doce consultas a Elsevier,
 * contra la cuota semanal de la casa. Cuarenta cada diez minutos por persona:
 * da para abrir todas las secciones de varias búsquedas, y corta a quien
 * abra y cierre sin parar. Lo ya contado se guarda media hora y no gasta.
 */
const scopusCuentasLimiter = build({
  windowMs: 10 * 60 * 1000,
  max: 40,
  message: 'Has pedido los números de los filtros muchas veces seguidas.',
  keyGenerator: porUsuario,
});

/**
 * Los mapas de coocurrencia para VOSviewer.
 *
 * Un mapa desde OpenAlex son hasta cinco páginas de doscientas obras contra el
 * presupuesto diario de la casa. Quince cada diez minutos por persona: da para
 * afinar el umbral, los sinónimos y lo excluido varias veces, y corta a quien
 * lo use para recorrer OpenAlex entero.
 */
const mapasLimiter = build({
  windowMs: 10 * 60 * 1000,
  max: 15,
  message: 'Has creado muchos mapas seguidos.',
  keyGenerator: porUsuario,
});

/**
 * El paso del umbral del asistente de mapas. Más holgado que el de crear:
 * responde de lo ya leído (ver `mapas.cache`), sin volver a OpenAlex, y la
 * pantalla lo pide cada vez que se cambia el tope de autores o el tesauro.
 */
const mapasUmbralLimiter = build({
  windowMs: 10 * 60 * 1000,
  max: 90,
  message: 'Has cambiado el umbral muchas veces seguidas.',
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
  message: 'Has intentado conectar Scopus muchas veces seguidas.',
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
  message: 'Se han pedido demasiados conectores desde esta conexión.',
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
  message: 'Estás escribiendo muy rápido. Si tienes prisa, escríbenos por WhatsApp.',
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
 * Fichas de asesor.
 *
 * Cinco por hora: nadie postula dos veces con motivo —el correo es único—, y
 * las pocas de más dejan sitio a quien se equivocó y vuelve a enviar. El enlace
 * se reparte a mano, así que un aluvión desde una IP no es entusiasmo, es un
 * script llenando el panel de fichas falsas que alguien tendría que leer.
 */
const asesorLimiter = build({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Has enviado varias fichas seguidas. Si algo salió mal, escríbenos por WhatsApp.',
});

/**
 * Capítulos que llegan a revisar.
 *
 * Tres por hora. Un tesista manda uno y, como mucho, lo vuelve a mandar porque
 * se equivocó de archivo; más que eso desde la misma IP no es prisa, es alguien
 * probando cuánto aguanta. Cada envío escribe un Word de hasta 25 MB en disco,
 * así que el freno aquí no protege una tabla: protege el disco.
 */
const pedidoLimiter = build({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: 'Has enviado varios trabajos seguidos. Si algo salió mal, escríbenos por WhatsApp.',
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
  cuantoFalta,
  mcpFallosLimiter,
  globalLimiter,
  authLimiter,
  emailLimiter,
  rewriteLimiter,
  paymentLimiter,
  trialClaimLimiter,
  zoteroSyncLimiter,
  zoteroConectarLimiter,
  mendeleySyncLimiter,
  mendeleyConectarLimiter,
  scopusBuscarLimiter,
  scopusConectarLimiter,
  scopusIaLimiter,
  scopusSemanticaLimiter,
  scopusCuentasLimiter,
  mapasLimiter,
  mapasUmbralLimiter,
  asistenteLimiter,
  reclamoLimiter,
  asesorLimiter,
  pedidoLimiter,
  mcpLimiter,
};

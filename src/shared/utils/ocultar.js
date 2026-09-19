'use strict';

/**
 * Quita de una URL lo que es una credencial, antes de que llegue al registro.
 *
 * POR QUÉ EXISTE
 * --------------
 * La URL del conector ES la licencia: `/mcp/<token>`, y quien la tenga trabaja
 * con el método a nombre del comprador. El registro de peticiones la guardaba
 * entera en cada llamada —3.239 líneas en un solo día, el 13 de septiembre de
 * 2026—, así que cualquiera con acceso al journal o a un respaldo tenía las
 * licencias de todos. El `redact` de pino tapa cabeceras y campos, pero no sabe
 * mirar DENTRO de una cadena.
 *
 * Se deja una pista de cuatro caracteres porque sin nada es imposible saber de
 * qué licencia habla una línea cuando alguien escribe «no me funciona». Cuatro
 * caracteres de un token de 43 no sirven para adivinar el resto.
 */

const RUTAS_CON_SECRETO = [
  // El conector. Cubre también lo que Claude pregunta por OAuth delante:
  // `/.well-known/oauth-protected-resource/mcp/<token>`.
  /(\/mcp\/)([A-Za-z0-9_-]+)/g,
  // El enlace firmado para descargar el Word. Caduca en media hora, pero en
  // esa media hora descarga la tesis de otro.
  /(\/proyectos\/descarga\/)([A-Za-z0-9._-]+)/g,
  // El de subir el formato de la facultad, y los de subir y bajar archivos de R:
  // firmados igual, y con ellos se escribe en el proyecto de otro.
  /(\/proyectos\/formato\/)([A-Za-z0-9._-]+)/g,
  /(\/r\/(?:subir|descarga)\/)([A-Za-z0-9._-]+)/g,
];

/** Parámetros de consulta que llevan una credencial: la vuelta de los OAuth (Zotero, Scopus, Mendeley). */
const CLAVES_SECRETAS = ['oauth_token', 'oauth_verifier', 'token', 'code', 'state'];
const PARAMETROS_CON_SECRETO = new RegExp(`([?&](?:${CLAVES_SECRETAS.join('|')})=)[^&#]*`, 'gi');

const OCULTO = '…';

function pista(secreto) {
  return secreto.length > 8 ? `${secreto.slice(0, 4)}${OCULTO}` : OCULTO;
}

function ocultarSecretosEnUrl(url) {
  if (typeof url !== 'string' || url === '') return url;

  let limpia = url;
  for (const patron of RUTAS_CON_SECRETO) {
    limpia = limpia.replace(patron, (_, prefijo, secreto) => `${prefijo}${pista(secreto)}`);
  }
  return limpia.replace(PARAMETROS_CON_SECRETO, `$1${OCULTO}`);
}

/** Lo mismo para la consulta ya troceada, que el registro también guarda. */
function ocultarConsulta(consulta) {
  if (!consulta || typeof consulta !== 'object') return consulta;
  return Object.fromEntries(
    Object.entries(consulta).map(([clave, valor]) => [
      clave,
      CLAVES_SECRETAS.includes(clave.toLowerCase()) ? OCULTO : valor,
    ]),
  );
}

/**
 * Y lo mismo para los parámetros de ruta.
 *
 * El registro guarda `req.params` además de la URL, y en `/mcp/:token` ese
 * `token` es la licencia entera. Ocultarla solo en la URL la dejaba escrita
 * en la línea de al lado. El `redact` de pino tampoco llega: `*.token` mira un
 * nivel, y esto va en `req.params.token`.
 */
function ocultarParams(params) {
  if (!params || typeof params !== 'object') return params;
  return Object.fromEntries(
    Object.entries(params).map(([clave, valor]) => [
      clave,
      clave === 'token' && typeof valor === 'string' ? pista(valor) : valor,
    ]),
  );
}

module.exports = { ocultarSecretosEnUrl, ocultarConsulta, ocultarParams };

'use strict';

/**
 * Revisa un correo antes de mandarle nada.
 *
 * `z.string().email()` solo mira la forma: `kelin@gamail.com` la tiene perfecta
 * y pasó, se generó un código cobrado y el correo salió hacia un dominio que no
 * es de nadie. Con los proveedores de siempre una errata así es casi segura, así
 * que se busca a propósito: un dominio a una o dos letras de gmail, hotmail,
 * outlook, yahoo o icloud no es otro proveedor, es uno de esos mal tecleado.
 *
 * Un dominio que no se parece a ninguno —el de una universidad, el de una
 * empresa— pasa sin más: no hay con qué compararlo.
 *
 * El panel tiene una copia de esta lógica para avisar mientras se escribe
 * (`shared/validators/correo.ts`). Esta es la que manda: el panel se puede
 * saltar, el servidor no.
 */

/** Dominios reales que se parecen a los grandes y no hay que «corregir». */
const DOMINIOS_BUENOS = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'hotmail.es',
  'outlook.com',
  'outlook.es',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.es',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  // A una letra de gmail, y son proveedores de verdad.
  'mail.com',
  'email.com',
]);

/**
 * Proveedores con los que se compara, y el dominio que se propone.
 *
 * gmail e icloud solo existen en `.com`: `gmail.es` o `gmail.co` son erratas
 * siempre. Los otros tienen versiones de país reales, y a esos solo se les
 * corrige una terminación que no existe.
 */
const PROVEEDORES = [
  { nombre: 'gmail', soloCom: true },
  { nombre: 'hotmail', soloCom: false },
  { nombre: 'outlook', soloCom: false },
  { nombre: 'yahoo', soloCom: false },
  { nombre: 'icloud', soloCom: true },
];

/** Terminaciones que no existen y que siempre quisieron decir `.com`. */
const TERMINACIONES_MAL = new Set([
  'con',
  'cmo',
  'comm',
  'coom',
  'cpm',
  'xom',
  'vom',
  'ocm',
  'cim',
  'om',
  'cm',
  'co',
  'c',
]);

/** Estas son reales, pero pegadas a gmail o hotmail no lo son. */
const TERMINACIONES_SOSPECHOSAS_SOLO_EN_PROVEEDOR = new Set(['om', 'cm', 'co', 'c']);

const FORMA = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/** Distancia entre dos palabras contando el cambio de dos letras seguidas. */
function distancia(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const coste = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + coste);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }

  return d[a.length][b.length];
}

/** El proveedor al que se parece `nombre`, o null. */
function proveedorParecido(nombre) {
  for (const proveedor of PROVEEDORES) {
    if (nombre === proveedor.nombre) return proveedor;
    // Con cinco letras, dos cambios ya convierten gmail en otra palabra.
    const tope = proveedor.nombre.length >= 6 ? 2 : 1;
    if (distancia(nombre, proveedor.nombre) <= tope) return proveedor;
  }
  return null;
}

/** El dominio bien escrito, o null si no hay nada que corregir. */
function dominioCorregido(dominio) {
  if (DOMINIOS_BUENOS.has(dominio)) return null;

  const partes = dominio.split('.');
  const nombre = partes[0];
  const terminacion = partes.slice(1).join('.');
  const proveedor = proveedorParecido(nombre);

  if (proveedor) {
    const fin =
      proveedor.soloCom || !terminacion || TERMINACIONES_MAL.has(terminacion) ? 'com' : terminacion;
    const propuesto = `${proveedor.nombre}.${fin}`;
    return propuesto === dominio ? null : propuesto;
  }

  // Un dominio cualquiera que termina en `.con` también es una errata.
  const ultima = partes[partes.length - 1];
  if (
    partes.length > 1 &&
    TERMINACIONES_MAL.has(ultima) &&
    !TERMINACIONES_SOSPECHOSAS_SOLO_EN_PROVEEDOR.has(ultima)
  ) {
    return [...partes.slice(0, -1), 'com'].join('.');
  }

  return null;
}

/**
 * Revisa un correo.
 *
 * Devuelve `{ correo, problema, sugerencia }`: `correo` normalizado (sin
 * espacios y en minúsculas), `problema` con el texto a enseñar o null si está
 * bien, y `sugerencia` con el correo corregido cuando se puede adivinar.
 */
function revisarCorreo(entrada) {
  const correo = String(entrada ?? '')
    .trim()
    .toLowerCase();

  if (!correo) return { correo, problema: 'Falta el correo.', sugerencia: null };

  const arrobas = correo.split('@').length - 1;

  if (arrobas === 0) {
    // «anagmail.com»: se olvidó la arroba delante de un dominio conocido.
    for (const dominio of DOMINIOS_BUENOS) {
      if (correo.endsWith(dominio) && correo.length > dominio.length) {
        const sugerencia = `${correo.slice(0, -dominio.length)}@${dominio}`;
        return { correo, problema: 'Le falta la @.', sugerencia };
      }
    }
    return {
      correo,
      problema: 'Le falta la @ y el dominio (por ejemplo @gmail.com).',
      sugerencia: null,
    };
  }

  if (arrobas > 1) return { correo, problema: 'Tiene más de una @.', sugerencia: null };

  const [usuario, dominio] = correo.split('@');

  if (!usuario)
    return {
      correo,
      problema: 'Falta lo que va antes de la @.',
      sugerencia: null,
    };

  const corregido = dominioCorregido(dominio);
  if (corregido) {
    return {
      correo,
      problema: `«@${dominio}» parece mal escrito.`,
      sugerencia: `${usuario}@${corregido}`,
    };
  }

  if (
    !FORMA.test(correo) ||
    usuario.startsWith('.') ||
    usuario.endsWith('.') ||
    correo.includes('..')
  ) {
    return {
      correo,
      problema: dominio.includes('.')
        ? 'No es un correo válido.'
        : 'Al dominio le falta la terminación (por ejemplo .com).',
      sugerencia: null,
    };
  }

  return { correo, problema: null, sugerencia: null };
}

// ── ¿El dominio recibe correo? ─────────────────────────────────────────────
//
// Las erratas no lo cubren todo: `zz@hou.com` no se parece a ningún proveedor y
// su dominio existe —tiene web—, pero no tiene buzones. Lo que decide si un
// correo puede llegar son los registros MX, y eso solo se sabe preguntando al
// DNS, así que esto vive en el servidor.

const dns = require('node:dns');

/** Un DNS lento no puede dejar la venta colgada: 3 s por intento, dos intentos. */
const resolverPorDefecto = new dns.promises.Resolver({ timeout: 3000, tries: 2 });

/** Una hora: los MX de un dominio no cambian de un rato para otro. */
const DURACION_CACHE_MS = 60 * 60 * 1000;
const cachePorDefecto = new Map();

/** Respuestas que dicen «este dominio no tiene correo», no «no se pudo saber». */
const SIN_CORREO = new Set(['ENODATA', 'ENOTFOUND']);

/**
 * true si el dominio tiene servidores de correo, false si no los tiene, null si
 * el DNS no contestó.
 *
 * Con null NO se bloquea: un DNS caído no es motivo para dejar de vender, y el
 * resultado no se guarda para volver a preguntar la próxima vez.
 *
 * Un dominio sin MX pero con web se da por que no recibe correo. La norma dice
 * que entonces se intenta la dirección de la web, pero en la práctica ningún
 * proveedor de correo personal funciona así, y es justo el caso de `hou.com`.
 */
async function dominioRecibeCorreo(dominio, opciones) {
  return (await consultarMx(dominio, opciones)).recibe;
}

/**
 * Lo mismo, pero con los servidores de correo del dominio ordenados por
 * prioridad: son a los que después se les pregunta por el buzón.
 */
async function consultarMx(
  dominio,
  {
    resolverMx = (d) => resolverPorDefecto.resolveMx(d),
    cache = cachePorDefecto,
    ahora = Date.now,
  } = {},
) {
  const guardado = cache.get(dominio);
  if (guardado && guardado.hasta > ahora()) {
    return { recibe: guardado.recibe, servidores: guardado.servidores ?? [] };
  }

  let servidores;
  try {
    const registros = await resolverMx(dominio);
    // Un MX vacío o «.» (RFC 7505) dice expresamente que ahí no se acepta correo.
    servidores = (registros ?? [])
      .filter((r) => r.exchange && r.exchange !== '.')
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .map((r) => r.exchange);
  } catch (error) {
    if (!SIN_CORREO.has(error.code)) return { recibe: null, servidores: [] };
    servidores = [];
  }

  const recibe = servidores.length > 0;
  cache.set(dominio, { recibe, servidores, hasta: ahora() + DURACION_CACHE_MS });
  return { recibe, servidores };
}

// ── ¿Existe el buzón? ──────────────────────────────────────────────────────
//
// Un dígito cambiado —`ana1990@gmail.com` por `ana1909@gmail.com`— pasa todo lo
// anterior: forma perfecta, dominio real con buzones. El código se cobraba y
// salía hacia una cuenta que no es de nadie, o peor, que es de otra persona.
//
// Lo único que sabe si la cuenta existe es el servidor de correo del dominio.
// Se le abre una conversación SMTP como si se fuera a mandar algo, se le dice
// el destinatario y se cuelga antes de enviar nada: Gmail, Outlook o Yahoo
// contestan ahí mismo «esa cuenta no existe» (550 5.1.1).
//
// Solo se bloquea con un «no existe» explícito. Todo lo demás —un servidor que
// acepta cualquier dirección, uno que rechaza la IP del VPS por política, el
// puerto 25 cerrado por el proveedor— es «no se sabe» y la venta sigue, con el
// aviso en el panel de que no se pudo comprobar.

const net = require('node:net');

/** 8 s por conversación: el panel espera la respuesta mientras se escribe. */
const TIEMPO_SONDEO_MS = 8000;

/** Si el puerto 25 no responde, no se vuelve a intentar en diez minutos. */
const PAUSA_PUERTO_CERRADO_MS = 10 * 60 * 1000;
let puertoCerradoHasta = 0;

const cacheBuzones = new Map();

/**
 * Respuestas que dicen «esa cuenta no existe» y no «no te dejo preguntar».
 *
 * Los códigos ampliados 5.1.x son de destinatario; los 5.7.x son de política
 * (IP en lista negra, remitente sin permiso) y nunca cuentan como inexistente.
 */
const CUENTA_INEXISTENTE =
  /\b5\.1\.(0|1|10)\b|does not exist|doesn'?t have an? .*account|no such (user|mailbox)|user unknown|unknown user|recipient (address )?rejected|invalid recipient|mailbox unavailable|mailbox (is )?disabled|address not found|no mailbox/i;

/** La dirección de `Nombre <a@b.com>` o de `a@b.com`. */
function direccionDe(remitente) {
  const entre = /<([^>]+)>/.exec(remitente);
  return (entre ? entre[1] : remitente).trim();
}

/**
 * Una conversación SMTP hasta el RCPT TO, sin llegar a mandar nada.
 *
 * Devuelve `{ etapa, codigo, texto }`: `etapa` es hasta dónde se llegó
 * («conexion» si nunca contestó), `codigo` y `texto` la última respuesta.
 */
function conversarSmtp(servidor, correo, { remitente, tiempo = TIEMPO_SONDEO_MS, puerto = 25 }) {
  const dominioPropio = remitente.split('@')[1] || 'localhost';
  const pasos = [
    { etapa: 'saludo', comando: `EHLO ${dominioPropio}` },
    { etapa: 'remitente', comando: `MAIL FROM:<${remitente}>` },
    { etapa: 'destinatario', comando: `RCPT TO:<${correo}>` },
  ];

  return new Promise((resolve) => {
    const socket = net.connect({ host: servidor, port: puerto });
    let etapa = 'conexion';
    let pendiente = '';
    let lineas = [];
    let terminado = false;

    const fin = (codigo, texto) => {
      if (terminado) return;
      terminado = true;
      // Se despide con educación si llegó a hablar; si no, se corta y ya.
      if (etapa !== 'conexion') socket.end('QUIT\r\n');
      socket.destroy();
      resolve({ etapa, codigo, texto });
    };

    socket.setTimeout(tiempo, () => fin(null, 'tiempo agotado'));
    socket.on('error', (error) => fin(null, error.code || error.message));

    socket.on('data', (trozo) => {
      pendiente += trozo.toString('utf8');
      const partes = pendiente.split(/\r?\n/);
      pendiente = partes.pop();

      for (const linea of partes) {
        lineas.push(linea);
        // Una respuesta de varias líneas lleva guion tras el código («250-»);
        // la última, un espacio o nada.
        const cierre = /^(\d{3})(?: |$)/.exec(linea);
        if (!cierre) continue;

        const codigo = Number(cierre[1]);
        const texto = lineas.join(' ');
        lineas = [];

        if (etapa === 'destinatario' || codigo >= 400) return fin(codigo, texto);

        const siguiente = pasos.shift();
        etapa = siguiente.etapa;
        socket.write(`${siguiente.comando}\r\n`);
      }
    });
  });
}

/** Lo que significa la respuesta: true existe, false no existe, null no se sabe. */
function veredicto({ etapa, codigo, texto }) {
  if (etapa !== 'destinatario' || !codigo) return null;
  if (codigo >= 200 && codigo < 300) return true;
  if (codigo >= 500 && !/\b5\.7\.\d+/.test(texto) && CUENTA_INEXISTENTE.test(texto)) return false;
  return null;
}

/** Sondeo real por la red. Apagado en las pruebas y con CORREO_SONDEAR_BUZON=false. */
async function sondearPorSmtp(correo, servidores) {
  // Perezoso: esta utilidad también se usa sin configuración cargada.
  const env = require('../../config/env');
  if (env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT || !env.CORREO_SONDEAR_BUZON) {
    return null;
  }
  if (Date.now() < puertoCerradoHasta) return null;

  const remitente = direccionDe(env.MAIL_FROM);

  // El de más prioridad, y uno de reserva si el primero no contesta.
  for (const servidor of servidores.slice(0, 2)) {
    const respuesta = await conversarSmtp(servidor, correo, { remitente });
    if (respuesta.etapa !== 'conexion') return veredicto(respuesta);
  }

  // Ninguno contestó: casi seguro el proveedor del VPS cierra el puerto 25.
  // Se deja de intentar un rato para no hacer esperar 16 s cada comprobación.
  puertoCerradoHasta = Date.now() + PAUSA_PUERTO_CERRADO_MS;
  require('../../config/logger').warn(
    { servidores },
    'No se pudo abrir el puerto 25 para comprobar un buzón; se sigue sin comprobar',
  );
  return null;
}

// ── El buzón por ZeroBounce ────────────────────────────────────────────────
//
// Hetzner cierra el puerto 25 de salida en las cuentas nuevas, así que el
// sondeo SMTP de arriba nunca llega a hablar con nadie. ZeroBounce hace esa
// misma pregunta desde sus servidores y contesta por HTTPS.
//
// Se usa su plan gratuito: 100 comprobaciones al mes. Solo se gasta una al
// vender un código —el panel y la generación comparten la caché de una hora—,
// y si se acaban el resultado es «no se sabe» y la venta sigue, igual que con
// el puerto cerrado. Lo que se escape lo atrapa el aviso de rebotes de Brevo
// (`modules/correo`).

const ZEROBOUNCE_URL = 'https://api.zerobounce.net/v2/validate';
const TIEMPO_ZEROBOUNCE_MS = 10000;

/** Sin créditos o con la clave mal, no se vuelve a preguntar en una hora. */
const PAUSA_ZEROBOUNCE_MS = 60 * 60 * 1000;
let zeroBounceParadoHasta = 0;

/**
 * Lo que significa la respuesta de ZeroBounce: true existe, false no existe,
 * null no se sabe.
 *
 * Solo `invalid` es un «no existe». `catch-all` (el dominio acepta cualquier
 * dirección), `unknown` y `do_not_mail` (desechable, de rol, tóxico) no dicen
 * que la cuenta falte, y bloquear con ellos frenaría ventas buenas.
 */
function veredictoZeroBounce(respuesta) {
  const estado = String(respuesta?.status ?? '').toLowerCase();
  if (estado === 'valid') return true;
  if (estado === 'invalid') return false;
  return null;
}

async function sondearPorZeroBounce(correo, { clave, pedir = fetch, ahora = Date.now } = {}) {
  if (ahora() < zeroBounceParadoHasta) return null;

  const url = `${ZEROBOUNCE_URL}?${new URLSearchParams({ api_key: clave, email: correo, ip_address: '' })}`;
  let datos;
  try {
    const respuesta = await pedir(url, { signal: AbortSignal.timeout(TIEMPO_ZEROBOUNCE_MS) });
    datos = await respuesta.json();
  } catch (error) {
    require('../../config/logger').warn({ err: error }, 'ZeroBounce no contestó; se sigue sin comprobar');
    return null;
  }

  // Sin créditos o con la clave mal contesta 200 con `error` y sin `status`.
  if (datos?.error) {
    zeroBounceParadoHasta = ahora() + PAUSA_ZEROBOUNCE_MS;
    require('../../config/logger').warn(
      { detalle: String(datos.error).slice(0, 200) },
      'ZeroBounce no comprobó el buzón (¿créditos del mes agotados?); se sigue sin comprobar',
    );
    return null;
  }
  return veredictoZeroBounce(datos);
}

/**
 * Con `ZEROBOUNCE_API_KEY`, pregunta a ZeroBounce; sin ella, por el puerto 25.
 * Apagado en las pruebas y con CORREO_SONDEAR_BUZON=false.
 */
async function sondearPorDefecto(correo, servidores) {
  const env = require('../../config/env');
  if (env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT || !env.CORREO_SONDEAR_BUZON) {
    return null;
  }
  if (env.ZEROBOUNCE_API_KEY) {
    return sondearPorZeroBounce(correo, { clave: env.ZEROBOUNCE_API_KEY });
  }
  return sondearPorSmtp(correo, servidores);
}

/**
 * true si el buzón existe, false si su servidor dice que no, null si no se sabe.
 * Solo se recuerdan las respuestas firmes, una hora.
 */
async function buzonExiste(
  correo,
  servidores,
  { sondearBuzon = sondearPorDefecto, cacheBuzon = cacheBuzones, ahora = Date.now } = {},
) {
  const guardado = cacheBuzon.get(correo);
  if (guardado && guardado.hasta > ahora()) return guardado.existe;

  let existe;
  try {
    existe = await sondearBuzon(correo, servidores);
  } catch {
    existe = null;
  }

  if (existe !== null) cacheBuzon.set(correo, { existe, hasta: ahora() + DURACION_CACHE_MS });
  return existe;
}

/** `fn` sobre cada elemento, como mucho `cuantos` a la vez. */
async function deAPocos(elementos, cuantos, fn) {
  const resultados = new Array(elementos.length);
  let siguiente = 0;
  const trabajar = async () => {
    while (siguiente < elementos.length) {
      const i = siguiente;
      siguiente += 1;
      resultados[i] = await fn(elementos[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(cuantos, elementos.length) }, trabajar));
  return resultados;
}

/**
 * Revisa una lista entera: forma y erratas, después el DNS y al final el buzón.
 *
 * Solo se pregunta por los correos que ya pasaron lo primero —una errata se
 * corta antes y conserva su sugerencia— y una sola vez por dominio: cien
 * compradores de gmail son una consulta al DNS.
 *
 * Cada revisión lleva `buzon`: true si su servidor confirmó que existe, false
 * si dijo que no, null si no se pudo saber. El panel lo enseña.
 */
async function revisarCorreos(correos, opciones) {
  const revisiones = correos.map((correo) => revisarCorreo(correo));

  const dominios = [
    ...new Set(revisiones.filter((r) => !r.problema).map((r) => r.correo.split('@')[1])),
  ];
  const respuestas = new Map(
    await Promise.all(
      dominios.map(async (dominio) => [dominio, await consultarMx(dominio, opciones)]),
    ),
  );

  // De cuatro en cuatro: una lista de treinta no abre treinta conexiones a la vez.
  return deAPocos(revisiones, 4, async (r) => {
    if (r.problema) return { ...r, buzon: null };
    const dominio = r.correo.split('@')[1];
    const { recibe, servidores } = respuestas.get(dominio);

    if (recibe === false) {
      return {
        ...r,
        buzon: false,
        problema: `«@${dominio}» no recibe correos: ese dominio no existe o no tiene buzones.`,
      };
    }
    if (recibe === null) return { ...r, buzon: null };

    const buzon = await buzonExiste(r.correo, servidores, opciones);
    if (buzon !== false) return { ...r, buzon };
    return {
      ...r,
      buzon,
      problema:
        `Esa cuenta no existe: el servidor de @${dominio} dice que no hay ningún buzón ` +
        'con ese nombre. Revísalo letra por letra con el comprador.',
    };
  });
}

module.exports = {
  revisarCorreo,
  revisarCorreos,
  dominioRecibeCorreo,
  buzonExiste,
  veredicto,
  conversarSmtp,
  veredictoZeroBounce,
  sondearPorZeroBounce,
};

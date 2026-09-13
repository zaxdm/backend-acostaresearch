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
async function dominioRecibeCorreo(
  dominio,
  {
    resolverMx = (d) => resolverPorDefecto.resolveMx(d),
    cache = cachePorDefecto,
    ahora = Date.now,
  } = {},
) {
  const guardado = cache.get(dominio);
  if (guardado && guardado.hasta > ahora()) return guardado.recibe;

  let recibe;
  try {
    const registros = await resolverMx(dominio);
    // Un MX vacío o «.» (RFC 7505) dice expresamente que ahí no se acepta correo.
    recibe = (registros ?? []).some((r) => r.exchange && r.exchange !== '.');
  } catch (error) {
    if (!SIN_CORREO.has(error.code)) return null;
    recibe = false;
  }

  cache.set(dominio, { recibe, hasta: ahora() + DURACION_CACHE_MS });
  return recibe;
}

/**
 * Revisa una lista entera: forma y erratas, y después el DNS.
 *
 * Solo se pregunta por los correos que ya pasaron lo primero —una errata se
 * corta antes y conserva su sugerencia— y una sola vez por dominio: cien
 * compradores de gmail son una consulta.
 */
async function revisarCorreos(correos, opciones) {
  const revisiones = correos.map((correo) => revisarCorreo(correo));

  const dominios = [
    ...new Set(revisiones.filter((r) => !r.problema).map((r) => r.correo.split('@')[1])),
  ];
  const respuestas = new Map(
    await Promise.all(
      dominios.map(async (dominio) => [dominio, await dominioRecibeCorreo(dominio, opciones)]),
    ),
  );

  return revisiones.map((r) => {
    if (r.problema) return r;
    const dominio = r.correo.split('@')[1];
    if (respuestas.get(dominio) !== false) return r;
    return {
      ...r,
      problema: `«@${dominio}» no recibe correos: ese dominio no existe o no tiene buzones.`,
    };
  });
}

module.exports = { revisarCorreo, revisarCorreos, dominioRecibeCorreo };

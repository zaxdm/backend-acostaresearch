'use strict';

const logger = require('../../config/logger');

/**
 * Lectura de la biblioteca de UN tesista en Mendeley.
 *
 * Solo GET. Mendeley no ofrece un permiso de solo lectura (ver
 * `mendeley.oauth`), así que la garantía de que no se escribe nada en su
 * biblioteca es este archivo: no tiene un solo método que no sea de lectura, y
 * no debe tenerlo.
 *
 * CÓMO SE SABE QUÉ HAY EN UNA CARPETA
 * -----------------------------------
 * `/documents` no filtra por carpeta. Lo que sí existe es
 * `/folders/{id}/documents`, que devuelve SOLO los ids. Así que la pasada es:
 * los ids de la carpeta, y luego la biblioteca con la ficha completa
 * (`view=all`), quedándose con los que están en esa lista. Una biblioteca de
 * tesis son pocos cientos de documentos: con 500 por página, un par de
 * peticiones. Y los mismos ids sirven para borrar lo que sacó de la carpeta,
 * que es lo que hace el tesista de verdad.
 */

const BASE = 'https://api.mendeley.com';
const POR_PAGINA = 500;
/** Tope de páginas por recorrido: 500 × 40 = 20.000 documentos. */
const MAX_PAGINAS = 40;

/** La biblioteca entera, sin carpeta. Mismo truco que en Zotero. */
const TODA_LA_BIBLIOTECA = '*';

const TIPOS = {
  documento: 'application/vnd.mendeley-document.1+json',
  carpeta: 'application/vnd.mendeley-folder.1+json',
  perfil: 'application/vnd.mendeley-profiles.1+json',
};

/** El `rel="next"` de la cabecera `Link`, que es como pagina Mendeley. */
function siguiente(res) {
  const link = res.headers.get('link');
  if (!link) return null;
  for (const parte of link.split(',')) {
    const encontrado = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(parte);
    if (encontrado) return encontrado[1];
  }
  return null;
}

async function esperarSiLoPide(res) {
  const segundos = Number(res.headers.get('retry-after') ?? 0);
  if (!Number.isFinite(segundos) || segundos <= 0) return false;
  logger.warn({ segundos }, 'Mendeley pide esperar antes de la siguiente petición');
  await new Promise((cumplir) => setTimeout(cumplir, Math.min(segundos, 60) * 1000));
  return true;
}

/**
 * Una petición con el token del tesista.
 *
 * El 401 se traduce aquí: significa que el token ya no vale, y es lo único que
 * al tesista le dice algo —«vuelve a conectar»—. El servicio renueva el token
 * ANTES de cada pasada, así que un 401 a media pasada es un permiso retirado.
 */
async function pedir(token, rutaOUrl, { params = {}, tipo = TIPOS.documento } = {}) {
  const url = rutaOUrl.startsWith('http') ? new URL(rutaOUrl) : new URL(`${BASE}${rutaOUrl}`);
  // Solo se habla con Mendeley. El `Link` de la paginación lo escribe su
  // servidor, pero seguirlo a otro dominio llevaría el token del tesista allí.
  if (url.origin !== BASE) throw new Error(`Mendeley devolvió una dirección ajena: ${url.origin}`);

  for (const [clave, valor] of Object.entries(params)) {
    if (valor !== undefined && valor !== null && valor !== '') {
      url.searchParams.set(clave, String(valor));
    }
  }

  const opciones = {
    headers: { Authorization: `Bearer ${token}`, Accept: `${tipo}, application/json` },
    signal: AbortSignal.timeout(30_000),
  };

  let res = await fetch(url, opciones);
  if ((res.status === 429 || res.status === 503) && (await esperarSiLoPide(res))) {
    res = await fetch(url, opciones);
  }

  if (res.status === 401 || res.status === 403) {
    const fallo = new Error('Mendeley ya no acepta esta conexión.');
    fallo.revocada = true;
    throw fallo;
  }

  if (!res.ok) {
    const detalle = await res.text().catch(() => '');
    throw new Error(`Mendeley respondió ${res.status}: ${detalle.slice(0, 200)}`);
  }

  return {
    datos: await res.json(),
    siguiente: siguiente(res),
    total: Number(res.headers.get('mendeley-count') ?? NaN),
  };
}

/** Todas las páginas de un listado, juntas. Solo para listados de ids o carpetas. */
async function todas(token, ruta, opciones) {
  const juntas = [];
  let respuesta = await pedir(token, ruta, opciones);

  for (let pagina = 1; ; pagina += 1) {
    if (Array.isArray(respuesta.datos)) juntas.push(...respuesta.datos);
    if (!respuesta.siguiente || pagina >= MAX_PAGINAS) break;
    respuesta = await pedir(token, respuesta.siguiente, { tipo: opciones.tipo });
  }

  return juntas;
}

/** Quién es: para el prefijo de sus fuentes y para enseñarle qué conectó. */
async function perfil(token) {
  const { datos } = await pedir(token, '/profiles/me', { tipo: TIPOS.perfil });
  const nombre =
    datos.display_name || [datos.first_name, datos.last_name].filter(Boolean).join(' ') || null;
  return { id: datos.id, nombre };
}

/**
 * Sus carpetas, en plano y con el camino: «Tesis › Antecedentes».
 *
 * Mendeley no dice cuántos documentos tiene cada carpeta, y preguntarlo serían
 * N peticiones más solo para pintar un número. Se deja nulo.
 */
async function carpetas(token) {
  const lista = await todas(token, '/folders', {
    params: { limit: POR_PAGINA },
    tipo: TIPOS.carpeta,
  });

  const porId = new Map(
    lista.map((c) => [c.id, { id: c.id, nombre: String(c.name ?? '').slice(0, 200), padre: c.parent_id || null }]),
  );

  return [...porId.values()]
    .map((carpeta) => {
      const camino = [carpeta.nombre];
      let padre = carpeta.padre;
      // Tope de profundidad por si una carpeta se tuviera a sí misma por
      // antepasado: es la base de datos de otro.
      for (let saltos = 0; padre && saltos < 10; saltos += 1) {
        const arriba = porId.get(padre);
        if (!arriba) break;
        camino.unshift(arriba.nombre);
        padre = arriba.padre;
      }
      return { clave: carpeta.id, nombre: camino.join(' › '), cuantas: null };
    })
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

/** Los ids que hay AHORA en la carpeta. `null` para la biblioteca entera. */
async function idsDeLaCarpeta(token, folderId) {
  if (folderId === TODA_LA_BIBLIOTECA) return null;
  const filas = await todas(token, `/folders/${encodeURIComponent(folderId)}/documents`, {
    params: { limit: POR_PAGINA },
    tipo: TIPOS.documento,
  });
  return filas.map((fila) => fila.id).filter(Boolean);
}

/**
 * Su biblioteca con la ficha completa, página a página.
 *
 * Se cede cada página en vez de juntarlas: este código corre de noche para
 * todos, y acumular «porque son pocos» es como se muere un VPS pequeño el día
 * que alguien conecta una biblioteca de diez mil.
 */
async function* paginasDeDocumentos(token) {
  let respuesta = await pedir(token, '/documents', {
    params: { view: 'all', limit: POR_PAGINA },
    tipo: TIPOS.documento,
  });

  for (let pagina = 1; ; pagina += 1) {
    if (!Array.isArray(respuesta.datos) || respuesta.datos.length === 0) break;
    yield respuesta.datos;
    if (!respuesta.siguiente || pagina >= MAX_PAGINAS) break;
    respuesta = await pedir(token, respuesta.siguiente, { tipo: TIPOS.documento });
  }
}

/** Cuántos documentos tiene en total, sin traerse ninguno. */
async function cuantasEnLaBiblioteca(token) {
  const { total } = await pedir(token, '/documents', {
    params: { limit: 1 },
    tipo: TIPOS.documento,
  });
  return Number.isFinite(total) ? total : null;
}

module.exports = {
  perfil,
  carpetas,
  idsDeLaCarpeta,
  paginasDeDocumentos,
  cuantasEnLaBiblioteca,
  siguiente,
  TODA_LA_BIBLIOTECA,
  POR_PAGINA,
};

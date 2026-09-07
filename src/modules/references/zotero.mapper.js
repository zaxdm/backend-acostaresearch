'use strict';

/**
 * Traduce un ítem de Zotero a una fila de `references`.
 *
 * Zotero guarda treinta y pico tipos de ítem con campos distintos —una revista
 * tiene `publicationTitle`, un libro `publisher`, una tesis `university`— y el
 * conector solo necesita saber cinco cosas de cualquiera de ellos. Aquí es
 * donde esa variedad se aplana, y en un solo sitio: el resto del código trabaja
 * siempre con la misma forma.
 */

/** Lo que no es una fuente: se sincroniza igual, pero no como fila propia. */
const NO_BIBLIOGRAFICOS = new Set(['note', 'attachment', 'annotation']);

const esFuente = (item) => !NO_BIBLIOGRAFICOS.has(item?.data?.itemType);
const esNota = (item) => item?.data?.itemType === 'note' && Boolean(item?.data?.parentItem);

/**
 * La ficha administrativa que Scopus cuelga de cada artículo al exportarlo.
 *
 * No es una nota de nadie: es papeleo del exportador —fecha de descarga, código
 * del congreso, dirección postal del autor de correspondencia—. Se descarta
 * porque el conector prefiere la nota al resumen, y enseñarle a un tesista
 * «Export Date: 06 September 2026; Conference code: 199657» en lugar de lo que
 * trata el artículo es peor que no enseñarle nada. Encima iría firmada como
 * nota de Acosta, que es lo que la haría creíble.
 *
 * El día que se escriba una nota de verdad sobre una de estas fuentes, la nota
 * de verdad entra: esto solo mira si el texto EMPIEZA por el papeleo.
 */
const esPapeleoDeScopus = (texto) =>
  /^\s*(export date|cited by|correspondence address|funding details|conference name|conference code|chemicals\/cas|references:)\s*:/i.test(
    texto ?? '',
  );

/** Quita el HTML de una nota de Zotero, que se guarda como marcado. */
function textoPlano(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Autores en formato de cita: «Hernández, R.; Fernández, C.».
 *
 * Solo cuentan los autores. Un editor o un traductor van en `creators` igual
 * que el autor, y mezclarlos produce citas que no se parecen a nada. Si no hay
 * ninguno —pasa con informes y normas—, se admite cualquier creador antes que
 * dejar la fuente sin firma.
 */
function autores(creators = []) {
  const propios = creators.filter((c) => c.creatorType === 'author');
  const lista = propios.length > 0 ? propios : creators;

  return lista
    .slice(0, 8)
    .map((c) => {
      if (c.name) return c.name;
      const inicial = c.firstName ? `${c.firstName.trim().charAt(0)}.` : '';
      return [c.lastName, inicial].filter(Boolean).join(', ');
    })
    .filter(Boolean)
    .join('; ');
}

/** El año, de un campo `date` que Zotero deja tal cual lo escribió la fuente. */
function anio(date) {
  const encontrado = /\b(1[5-9]\d{2}|20\d{2})\b/.exec(String(date ?? ''));
  return encontrado ? Number(encontrado[1]) : null;
}

/** Dónde se publicó, sea lo que sea el tipo de ítem. */
function fuente(data) {
  return (
    data.publicationTitle ||
    data.bookTitle ||
    data.proceedingsTitle ||
    data.encyclopediaTitle ||
    data.university ||
    data.institution ||
    data.publisher ||
    data.repository ||
    data.websiteTitle ||
    null
  );
}

/** El DOI, venga del campo propio o escondido en `extra`. */
function doi(data) {
  if (data.DOI) return String(data.DOI).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  const enExtra = /DOI:\s*(\S+)/i.exec(data.extra ?? '');
  return enExtra ? enExtra[1] : null;
}

/**
 * Minúsculas y sin tildes, para que buscar «metodologia» encuentre
 * «Metodología». Quien escribe desde Claude no pone tildes la mitad de las
 * veces, y una búsqueda que falla por eso parece una biblioteca vacía.
 */
function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

const recortar = (valor, largo) => (valor ? String(valor).slice(0, largo) : null);

/**
 * Arma la fila. `notas` son las notas hijas ya reunidas por el servicio.
 *
 * Las etiquetas de producto (`tesis`, `articulo`) NO se guardan aquí como
 * filtro: salen aparte, en `reference_groups`, porque el filtro se consulta con
 * un índice y la lista de etiquetas solo se enseña.
 */
function aFila(item, notas = []) {
  const data = item.data;
  const etiquetas = (data.tags ?? []).map((t) => t.tag).filter(Boolean);
  const cuerpoNotas = notas.map((n) => textoPlano(n.data.note)).filter(Boolean).join('\n\n');
  const resumen = textoPlano(data.abstractNote);

  const fila = {
    zoteroKey: data.key,
    version: item.version ?? data.version ?? 0,
    itemType: data.itemType,
    title: recortar(data.title || '(sin título)', 500),
    authors: recortar(autores(data.creators), 500) ?? '',
    year: anio(data.date),
    source: recortar(fuente(data), 300),
    doi: recortar(doi(data), 200),
    url: recortar(data.url, 500),
    abstract: resumen || null,
    notes: cuerpoNotas || null,
    tags: recortar(etiquetas.join(', '), 500) ?? '',
  };

  fila.busqueda = normalizar(
    [fila.title, fila.authors, fila.source, fila.year, resumen, cuerpoNotas, etiquetas.join(' ')]
      .filter(Boolean)
      .join(' '),
  );

  return { fila, etiquetas };
}

module.exports = { esFuente, esNota, esPapeleoDeScopus, aFila, normalizar, textoPlano };

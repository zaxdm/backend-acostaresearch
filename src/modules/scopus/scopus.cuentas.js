'use strict';

const openalex = require('../references/openalex.client');

/**
 * Los números APROXIMADOS de los filtros del buscador de Scopus.
 *
 * Scopus no nos da sus facetas con esta clave, y contar opción por opción
 * solo sale a cuenta en las listas cortas (año, tipo, idioma…: ver
 * `scopus.service.cuentas`). Para el área —27 opciones— y para las que
 * dependen de lo encontrado —país, revista, autor, afiliación, patrocinador—
 * se le pregunta a OpenAlex con los mismos conceptos, en una consulta
 * agrupada por filtro.
 *
 * SON DE OTRO CATÁLOGO. OpenAlex indexa más que Scopus —para la misma
 * búsqueda da el doble de obras— así que sus números sirven para ver qué pesa
 * más, no como el total de Scopus. La web los marca «≈» y lo dice.
 */

/**
 * Las áreas de OpenAlex SON las de Scopus: sus «fields» siguen la clasificación
 * ASJC, con el mismo número. Lo que cambia es el nombre del código.
 */
const AREA_POR_CAMPO = {
  11: 'AGRI', 12: 'ARTS', 13: 'BIOC', 14: 'BUSI', 15: 'CENG', 16: 'CHEM', 17: 'COMP',
  18: 'DECI', 19: 'EART', 20: 'ECON', 21: 'ENER', 22: 'ENGI', 23: 'ENVI', 24: 'IMMU',
  25: 'MATE', 26: 'MATH', 27: 'MEDI', 28: 'NEUR', 29: 'NURS', 30: 'PHAR', 31: 'PHYS',
  32: 'PSYC', 33: 'SOCI', 34: 'VETE', 35: 'DENT', 36: 'HEAL',
};

/** Qué campo de OpenAlex se agrupa para cada filtro de la web. */
const GRUPOS = {
  area: 'primary_topic.field.id',
  pais: 'authorships.countries',
  revista: 'primary_location.source.id',
  autor: 'authorships.author.id',
  afiliacion: 'authorships.institutions.id',
  patrocinador: 'funders.id',
};

/**
 * La palabra clave NO se cuenta aquí: las de OpenAlex las pone un clasificador
 * y no los autores, y para una búsqueda de pensamiento crítico con IA salían
 * «Generative grammar» y «Psychology». Sugerir eso como palabra clave
 * engañaría. Esa sección sigue siendo para escribir.
 *
 * En la revista se dejan fuera los repositorios —Zenodo, SSRN, arXiv—, que
 * OpenAlex cuenta como fuentes y Scopus no indexa: se agrupa solo lo que sale
 * en revistas y actas de congreso.
 */
const FILTRO_EXTRA = { revista: 'primary_location.source.type:journal|conference' };

/** Un término apto para ir dentro de la búsqueda de OpenAlex. */
const limpio = (texto) =>
  String(texto ?? '')
    .replace(/[()"{}[\]:,|]/g, ' ')
    .replace(/\b(AND|OR|NOT)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

/**
 * Los conceptos, en el filtro de OpenAlex: cada concepto con sus sinónimos
 * unidos por OR y todos los conceptos por AND, como la ecuación de Scopus.
 * Exportado para las pruebas.
 */
function filtroDe({ conceptos, desde = null, hasta = null }) {
  const grupos = conceptos
    .map((concepto) =>
      [concepto.nombre, ...(concepto.sinonimos ?? [])]
        .map(limpio)
        .filter(Boolean)
        .map((t) => `"${t}"`),
    )
    .filter((terminos) => terminos.length > 0)
    .map((terminos) => `(${terminos.join(' OR ')})`);

  if (grupos.length === 0) return null;

  const partes = [`title_and_abstract.search:${grupos.join(' AND ')}`];
  if (desde || hasta) partes.push(`publication_year:${desde ?? ''}-${hasta ?? ''}`);
  return partes.join(',');
}

/** Lo ya contado, media hora: abrir y cerrar secciones no repite consultas. */
const GUARDADAS = new Map();
const VIDA_MS = 30 * 60 * 1000;

/**
 * Cuántas obras hay en cada valor de cada filtro, según OpenAlex.
 *
 * Devuelve, por filtro, los valores con más obras: `{ valor, texto, n }`. En el
 * área, `valor` es el código de Scopus (`SOCI`) para que la web marque su
 * casilla; en los demás es el nombre, que es lo que se escribe en el filtro.
 * `agrupar` existe para las pruebas.
 */
async function aproximadas(consulta, { agrupar = openalex.agrupar } = {}) {
  const filtro = filtroDe(consulta);
  if (!filtro) return { total: null, grupos: {} };

  const guardada = GUARDADAS.get(filtro);
  if (guardada && Date.now() - guardada.cuando < VIDA_MS) return guardada.valor;

  const claves = Object.keys(GRUPOS);
  const respuestas = await Promise.all(
    claves.map((clave) =>
      agrupar(
        FILTRO_EXTRA[clave] ? `${filtro},${FILTRO_EXTRA[clave]}` : filtro,
        GRUPOS[clave],
        clave === 'area' ? 27 : 8,
      ).catch(() => null),
    ),
  );

  const grupos = {};
  let total = null;
  claves.forEach((clave, i) => {
    const respuesta = respuestas[i];
    if (!respuesta) return;
    total ??= respuesta.total;
    grupos[clave] = respuesta.grupos
      .map((g) => {
        if (clave === 'area') {
          const codigo = AREA_POR_CAMPO[Number(g.clave.split('/').pop())];
          return codigo ? { valor: codigo, texto: g.nombre, n: g.obras } : null;
        }
        if (clave === 'autor') {
          // «Sudhakar Geruganti» → «Geruganti, S.»: así lo encuentra AUTHOR-NAME.
          const nombre = openalex.nombreApa?.(g.nombre) ?? g.nombre;
          return nombre ? { valor: nombre, texto: g.nombre, n: g.obras } : null;
        }
        return g.nombre ? { valor: g.nombre, texto: g.nombre, n: g.obras } : null;
      })
      .filter(Boolean);
  });

  const valor = { total, grupos };
  if (GUARDADAS.size >= 300) GUARDADAS.delete(GUARDADAS.keys().next().value);
  if (Object.keys(grupos).length > 0) GUARDADAS.set(filtro, { valor, cuando: Date.now() });
  return valor;
}

module.exports = { aproximadas, filtroDe, AREA_POR_CAMPO };

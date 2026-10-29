'use strict';

/**
 * LA Referencia entera: tesis y artículos de los repositorios de toda
 * Latinoamérica (y España y Portugal), no solo del Perú. Las del Perú siguen
 * también en «Tesis peruanas», que va por ALICIA y trae pregrado; esta red solo
 * recoge posgrado. Ver `references/lareferencia.client.js`.
 */

const logger = require('../../config/logger');
const lareferencia = require('../references/lareferencia.client');
const { CAIDA } = require('./comun');

/** El formato de VuFind con el tipo del contrato. */
const TIPOS = {
  masterThesis: 'dissertation',
  doctoralThesis: 'dissertation',
  bachelorThesis: 'dissertation',
  article: 'article',
  book: 'book',
  bookPart: 'chapter',
};

const sinPrefijo = (id) => String(id ?? '').replace(lareferencia.PREFIJO, '');

/** «EC_…» → «EC»: el país del repositorio, para decirlo en la fila. */
const paisDe = (id) => sinPrefijo(id).split('_')[0] || null;

function comoResultado(f) {
  const pais = paisDe(f.id);
  return {
    id: sinPrefijo(f.id),
    doi: null,
    titulo: f.title,
    autores: f.authors || '(Autor no consignado)',
    anio: f.year ?? null,
    revista: [f.source, pais].filter(Boolean).join(' · ') || null,
    idioma: null,
    citas: 0,
    enlace: f.url ?? null,
    pdfLibre: null,
    resumen: f.abstract ?? null,
    tipo: TIPOS[f.itemType] ?? 'other',
  };
}

module.exports = {
  clave: 'latinoamerica',
  nombre: 'Tesis de Latinoamérica',
  detalle: 'LA Referencia: tesis de posgrado y artículos de toda la región',
  activa: () => true,

  async buscar({ consulta, pagina = 1, porPagina = 25, desde = null, hasta = null }) {
    try {
      const { total, fichas } = await lareferencia.buscar({ consulta, pagina, desde, hasta, toda: true, porPagina });
      return { resultados: fichas.map(comoResultado), total, caida: false };
    } catch (error) {
      logger.warn({ err: error }, 'LA Referencia no respondió a la búsqueda de toda la red');
      return CAIDA;
    }
  },

  async porIds(ids) {
    const fichas = await lareferencia.porIdsDeLaRed(ids.slice(0, 25)).catch(() => []);
    return fichas.map((f) => ({ ...f, id: sinPrefijo(f.id), doi: null }));
  },
};

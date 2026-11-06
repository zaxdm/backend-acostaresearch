'use strict';

/**
 * Los indicadores de una revista, para elegir dónde publicar una revisión
 * (herramienta "consultar_revista" del conector, 5-nov-2026).
 *
 * POR QUÉ
 * -------
 * La Fase 1 de la ruta de revisión se trababa al elegir revista: la skill
 * mandaba a leer la ficha de Scimago, que contesta a casi toda lectura
 * automática con un desafío anti-robots, y el tesista se quedaba esperando
 * una captura que no sabía sacar. La Serial Title API de Elsevier, con la
 * clave de la casa, da lo mismo que la ficha de la revista en Scopus: SJR,
 * SNIP, CiteScore y el percentil de CiteScore en cada categoría, que es de
 * donde sale el cuartil de Scopus. Probado el 5-nov-2026 con la vista
 * CITESCORE (la ENHANCED, no: «not authorized»).
 *
 * Lo que NO da: el cuartil SJR de Scimago, que se calcula distinto. Se dice
 * siempre de qué cuartil se habla. Y no da el APC ni si está en DOAJ: eso se
 * pide a OpenAlex (`/sources`), que es abierto.
 */

const logger = require('../../config/logger');
const env = require('../../config/env');
const cliente = require('./scopus.client');

const BASE = 'https://api.elsevier.com/content/serial/title';
const OPENALEX_FUENTES = 'https://api.openalex.org/sources';
// La vista CITESCORE trae todos los años de la revista y Elsevier tarda: medido
// entre 15 y 29 segundos el 5-nov-2026.
const TIEMPO_LIMITE_MS = 35_000;
const CUANTAS = 3;

/** Q1 del percentil 75 al 99, y así (la definición de Scopus para CiteScore). */
function cuartilDe(percentil) {
  const p = Number(percentil);
  if (!Number.isFinite(p)) return null;
  if (p >= 75) return 'Q1';
  if (p >= 50) return 'Q2';
  if (p >= 25) return 'Q3';
  return 'Q4';
}

const pareceIssn = (texto) => /^\d{4}-?\d{3}[\dXx]$/.test(String(texto).trim());

/** El primer valor de una lista de Elsevier («SJRList.SJR[0]»), con su año. */
function metrica(lista) {
  const primero = Array.isArray(lista) ? lista[0] : lista;
  if (!primero?.$) return null;
  return { valor: primero.$, anio: primero['@year'] ?? null };
}

/**
 * Una revista de la Serial Title API en la forma que se le cuenta a Claude.
 *
 * El cuartil sale del ÚLTIMO AÑO COMPLETO de CiteScore («Complete»), no del
 * «In-Progress» del año en curso, que cambia cada mes.
 */
function comoRevista(e) {
  const areas = new Map((e['subject-area'] ?? []).map((a) => [String(a['@code']), a.$]));
  const anios = e.citeScoreYearInfoList?.citeScoreYearInfo ?? [];
  const completo = anios.find((a) => a['@status'] === 'Complete') ?? null;
  const info = completo?.citeScoreInformationList?.[0]?.citeScoreInfo?.[0] ?? null;

  const categorias = (info?.citeScoreSubjectRank ?? [])
    .map((r) => ({
      categoria: areas.get(String(r.subjectCode)) ?? `código ${r.subjectCode}`,
      puesto: r.rank ?? null,
      percentil: r.percentile ?? null,
      cuartil: cuartilDe(r.percentile),
    }))
    .sort((a, b) => Number(b.percentil ?? 0) - Number(a.percentil ?? 0));

  return {
    titulo: e['dc:title'] ?? '(sin título)',
    editorial: e['dc:publisher'] ?? null,
    issn: e['prism:issn'] ?? null,
    eissn: e['prism:eIssn'] ?? null,
    sourceId: e['source-id'] ?? null,
    enlace: (e.link ?? []).find((l) => l['@ref'] === 'scopus-source')?.['@href'] ?? null,
    sjr: metrica(e.SJRList?.SJR),
    snip: metrica(e.SNIPList?.SNIP),
    citeScore: completo ? { valor: info?.citeScore ?? null, anio: completo['@year'] } : null,
    categorias,
    accesoAbierto: e.openaccess === '1' || e.openaccess === 1 ? 'sí' : null,
  };
}

async function pedirJson(url, opciones = {}) {
  const res = await fetch(url, { ...opciones, signal: AbortSignal.timeout(TIEMPO_LIMITE_MS) }).catch((error) => {
    logger.warn({ err: error }, 'Revistas: la petición no llegó');
    return null;
  });
  if (!res) return { ok: false, estado: 0, cuerpo: null };
  const cuerpo = await res.json().catch(() => null);
  return { ok: res.ok, estado: res.status, cuerpo };
}

/** APC y DOAJ de OpenAlex por ISSN. Falla hacia el silencio. */
async function deOpenAlex(issns) {
  const lista = issns.filter(Boolean);
  if (lista.length === 0) return null;
  const url = new URL(OPENALEX_FUENTES);
  url.searchParams.set('filter', `issn:${lista.join('|')}`);
  url.searchParams.set('select', 'display_name,is_in_doaj,apc_usd,is_oa,homepage_url,host_organization_name');
  url.searchParams.set('mailto', env.OPENALEX_MAILTO || env.MAIL_FROM);
  if (env.OPENALEX_API_KEY) url.searchParams.set('api_key', env.OPENALEX_API_KEY);
  const r = await pedirJson(url);
  const fuente = r.ok ? r.cuerpo?.results?.[0] : null;
  if (!fuente) return null;
  return {
    enDoaj: Boolean(fuente.is_in_doaj),
    accesoAbierto: Boolean(fuente.is_oa),
    apcUsd: fuente.apc_usd ?? null,
    web: fuente.homepage_url ?? null,
  };
}

/**
 * Busca la revista por ISSN o por nombre y devuelve hasta tres coincidencias,
 * cada una con sus indicadores de Scopus y, si OpenAlex la conoce, su APC.
 *
 * @returns {{ revistas: object[], consultado: string }}
 */
async function consultar({ revista }) {
  const texto = String(revista ?? '').trim();
  const url = new URL(BASE);
  if (pareceIssn(texto)) url.searchParams.set('issn', texto.replace('-', ''));
  else url.searchParams.set('title', texto);
  url.searchParams.set('view', 'CITESCORE');
  url.searchParams.set('count', String(CUANTAS));

  const r = await pedirJson(url, { headers: cliente.cabeceras(null) });
  // Sin coincidencias, Elsevier contesta 404 «RESOURCE_NOT_FOUND»: no es un fallo.
  if (r.estado === 404) return { revistas: [], consultado: new Date().toISOString().slice(0, 10) };
  if (!r.ok) {
    logger.warn({ estado: r.estado, elsevier: r.cuerpo?.['service-error'] ?? null }, 'Revistas: Scopus rechazó');
    throw cliente.comoFallo(r.estado || 504);
  }

  const entradas = (r.cuerpo?.['serial-metadata-response']?.entry ?? []).filter((e) => !e.error).slice(0, CUANTAS);
  const revistas = [];
  for (const e of entradas) {
    const datos = comoRevista(e);
    datos.abierta = await deOpenAlex([datos.issn, datos.eissn].map((i) => i && i.replace(/^(\d{4})(\d{3}[\dXx])$/, '$1-$2')));
    revistas.push(datos);
  }
  return { revistas, consultado: new Date().toISOString().slice(0, 10) };
}

module.exports = { consultar, comoRevista, cuartilDe };

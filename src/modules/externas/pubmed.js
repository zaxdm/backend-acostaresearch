'use strict';

/**
 * PubMed, por las E-utilities del NCBI. Contrato en `index.js`.
 *
 * Tres llamadas por búsqueda: `esearch` (ids y total), `esummary` (la ficha en
 * JSON) y `efetch` (el resumen, que `esummary` no trae; solo existe en XML).
 * Sin clave el NCBI admite 3 peticiones por segundo y con `NCBI_API_KEY`, 10:
 * por eso todas pasan por `turno`, que las espacia aunque busquen varios
 * tesistas a la vez.
 */

const comun = require('./comun');

const BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
const MAXIMO_IDS = 25;

/** Lo que tarda como mínimo entre dos peticiones al NCBI, con margen. */
function espacioMs() {
  return comun.clave('NCBI_API_KEY') ? 110 : 350;
}

let siguienteLibre = 0;

/** Espera su hueco para no pasar del límite del NCBI (que responde 429). */
async function turno() {
  const ahora = Date.now();
  const mio = Math.max(ahora, siguienteLibre);
  siguienteLibre = mio + espacioMs();
  if (mio > ahora) await new Promise((r) => setTimeout(r, mio - ahora));
}

/** La URL de una utilidad con la identificación que pide el NCBI. */
function url(utilidad, params) {
  const u = new URL(`${utilidad}.fcgi`, BASE);
  u.searchParams.set('db', 'pubmed');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  u.searchParams.set('tool', 'acostaresearch');
  u.searchParams.set('email', comun.contacto());
  const llave = comun.clave('NCBI_API_KEY');
  if (llave) u.searchParams.set('api_key', llave);
  return u;
}

async function pedir(u, opciones = {}) {
  await turno();
  return comun.pedir(u, { base: 'PubMed', ...opciones });
}

/**
 * «Smith JA» → «Smith, J. A.». PubMed (y Europe PMC) ya dan apellido e
 * iniciales; pasarlo por `autoresApa` lo tomaría por nombre de pila. Un
 * autor colectivo («WHO Study Group») no termina en iniciales y queda igual.
 */
function autorDePubmed(nombre) {
  const limpio = String(nombre ?? '').trim().replace(/\.$/, '');
  const m = limpio.match(/^(.+?)\s+(\p{Lu}{1,4})$/u);
  if (!m) return limpio || null;
  return `${m[1]}, ${Array.from(m[2], (c) => `${c}.`).join(' ')}`;
}

function autores(lista = []) {
  const nombres = lista.map(autorDePubmed).filter(Boolean).slice(0, 8);
  return nombres.join('; ') || '(Autor no consignado)';
}

/** Los códigos de idioma del NCBI (ISO 639-2) a los de dos letras de la web. */
const IDIOMAS = { eng: 'en', spa: 'es', por: 'pt', fre: 'fr', ger: 'de', ita: 'it', chi: 'zh', jpn: 'ja', rus: 'ru' };
function idioma(codigo) {
  if (!codigo) return null;
  return IDIOMAS[codigo] ?? codigo;
}

function tipo(pubtypes = []) {
  const t = pubtypes.join('|');
  if (/Preprint/i.test(t)) return 'preprint';
  if (/Review/i.test(t)) return 'review';
  if (/Book|Chapter/i.test(t)) return 'book';
  return 'article';
}

const ITEM = { preprint: 'preprint', book: 'book' };

/** El resumen de cada PMID del XML de `efetch`, con sus rótulos («METHODS: …»). */
function resumenesDelXml(xml) {
  const porPmid = new Map();
  const articulos = String(xml ?? '').split(/<\/Pubmed(?:Book)?Article>/);
  for (const trozo of articulos) {
    const pmid = trozo.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1];
    if (!pmid) continue;
    const partes = [...trozo.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map(([, attrs, texto]) => {
      const rotulo = attrs.match(/Label="([^"]+)"/)?.[1];
      const limpio = comun.textoLimpio(texto);
      return limpio && rotulo ? `${rotulo}: ${limpio}` : limpio;
    });
    const resumen = partes.filter(Boolean).join(' ');
    if (resumen) porPmid.set(pmid, resumen);
  }
  return porPmid;
}

/**
 * Fichas y resúmenes de unos PMID. `esummary` manda: si `efetch` falla, salen
 * igual, sin resumen. Devuelve null si `esummary` no respondió.
 */
async function registros(ids) {
  if (ids.length === 0) return [];
  const lista = ids.join(',');
  const resumenP = pedir(url('efetch', { id: lista, retmode: 'xml', rettype: 'abstract' }), { comoTexto: true });
  const fichas = await pedir(url('esummary', { id: lista, retmode: 'json' }));
  const xml = await resumenP;
  if (!fichas?.ok) return null;

  const resumenes = xml?.ok ? resumenesDelXml(xml.texto) : new Map();
  const datos = fichas.json?.result ?? {};
  return ids
    .map((id) => datos[id])
    .filter((d) => d && !d.error && d.uid)
    .map((d) => ({ d, resumen: resumenes.get(String(d.uid)) ?? null }));
}

function aResultado({ d, resumen }) {
  const doi = comun.limpiarDoi((d.articleids ?? []).find((a) => a.idtype === 'doi')?.value);
  return {
    id: String(d.uid),
    doi,
    titulo: comun.textoLimpio(d.title) ?? '(sin título)',
    autores: autores((d.authors ?? []).map((a) => a.name)),
    anio: comun.anioDe(d.pubdate) ?? comun.anioDe(d.sortpubdate),
    revista: d.fulljournalname || d.source || null,
    idioma: idioma(d.lang?.[0]),
    // `pmcrefcount`: cuántos artículos de PMC lo citan. Es lo único que da PubMed.
    citas: Number(d.pmcrefcount) || 0,
    enlace: `https://pubmed.ncbi.nlm.nih.gov/${d.uid}/`,
    // PubMed no enlaza PDF; el de PMC no siempre es abierto, así que no se promete.
    pdfLibre: null,
    resumen,
    tipo: tipo(d.pubtype),
  };
}

async function buscar({ consulta, palabras, pagina = 1, porPagina = 25, desde = null, hasta = null } = {}) {
  try {
    const termino = String(consulta || palabras || '').trim();
    if (!termino) return { resultados: [], total: 0, caida: false };
    const tam = Math.min(Math.max(Number(porPagina) || 25, 1), MAXIMO_IDS);
    const params = {
      term: termino,
      retmode: 'json',
      retmax: tam,
      retstart: (Math.max(Number(pagina) || 1, 1) - 1) * tam,
      sort: 'relevance',
    };
    if (desde || hasta) {
      // El NCBI exige las dos fechas juntas.
      params.datetype = 'pdat';
      params.mindate = desde || 1800;
      params.maxdate = hasta || new Date().getFullYear() + 1;
    }
    const res = await pedir(url('esearch', params));
    const r = res?.ok ? res.json?.esearchresult : null;
    if (!r || r.ERROR) return comun.CAIDA;

    const total = Number(r.count) || 0;
    const ids = (r.idlist ?? []).map(String);
    const lista = await registros(ids);
    if (lista === null) return comun.CAIDA;
    return { resultados: lista.map(aResultado), total, caida: false };
  } catch {
    return comun.CAIDA;
  }
}

async function porIds(ids = []) {
  const validos = [...new Set((ids ?? []).map((i) => String(i).trim()))]
    .filter((i) => /^\d{1,9}$/.test(i))
    .slice(0, MAXIMO_IDS);
  const lista = await registros(validos);
  return (lista ?? []).map((reg) => {
    const r = aResultado(reg);
    const { d } = reg;
    return {
      id: r.id,
      doi: r.doi,
      title: r.titulo,
      authors: r.autores,
      year: r.anio,
      source: r.revista,
      volume: d.volume || null,
      issue: d.issue || null,
      pages: d.pages || null,
      url: r.enlace,
      abstract: r.resumen,
      itemType: ITEM[r.tipo] ?? 'journalArticle',
    };
  });
}

module.exports = {
  clave: 'pubmed',
  nombre: 'PubMed',
  detalle: 'Salud y medicina',
  activa: () => true,
  buscar,
  porIds,
  // Para Europe PMC, que da los autores igual, y para las pruebas.
  autorDePubmed,
  resumenesDelXml,
};

'use strict';

const alicia = require('./alicia.client');
const lareferencia = require('./lareferencia.client');
const openalex = require('./openalex.client');

const UMBRAL = 0.90;
const CONCURRENCIA = 3;
const normalizar = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (s) => new Set(normalizar(s).split(' ').filter(Boolean));
const CONECTORES = new Set('a al de del el la las los en y e o u con para por un una'.split(' '));

function similitud(a, b) {
  const x = tokens(a), y = tokens(b);
  const union = new Set([...x, ...y]);
  return union.size ? [...x].filter((t) => y.has(t)).length / union.size : 0;
}

function mismoNombre(a, b) {
  const partes = (s) => {
    const [apellido, nombres] = s.split(',');
    const palabras = normalizar(apellido).split(' ');
    return nombres === undefined
      ? { apellidos: palabras.slice(-2), nombres: palabras.slice(0, -2) }
      : { apellidos: palabras, nombres: normalizar(nombres).split(' ') };
  };
  const x = partes(a), y = partes(b);
  if (x.apellidos.join(' ') !== y.apellidos.join(' ')) return false;
  if (!x.nombres.length || !y.nombres.length) return false;
  // Aceptar iniciales del catálogo, sin aceptar un nombre completo distinto.
  return x.nombres.every((n, i) => y.nombres[i] && (n === y.nombres[i] || (Math.min(n.length, y.nombres[i].length) === 1 && n[0] === y.nombres[i][0])));
}

function coincide(extraida, ficha) {
  if (similitud(extraida.titulo, ficha.title) < UMBRAL) return false;
  // Una sola localidad, población, negación o cifra distinta puede ser OTRA
  // tesis aunque comparta el 95 % de palabras. Solo variar conectores es seguro.
  const sustantivos = (s) => [...tokens(s)].filter((t) => !CONECTORES.has(t)).sort().join(' ');
  if (sustantivos(extraida.titulo) !== sustantivos(ficha.title)) return false;
  if (extraida.anio && Number(extraida.anio) !== Number(ficha.year)) return false;
  if (extraida.autores) {
    const propios = extraida.autores.split(';').map((s) => s.trim()).filter(Boolean);
    const oficiales = String(ficha.authors ?? '').split(';').map((s) => s.trim()).filter(Boolean);
    if (propios.length !== oficiales.length) return false;
    const usados = new Set();
    for (const autor of propios) {
      const i = oficiales.findIndex((o, i) => !usados.has(i) && mismoNombre(autor, o));
      if (i < 0) return false;
      usados.add(i);
    }
  }
  return true;
}

function urlSegura(valor) {
  try {
    const u = new URL(valor);
    return /^https?:$/.test(u.protocol) && !u.username && !u.password && u.href.length <= 500 ? u.href : '';
  } catch { return ''; }
}

function mejor(extraida, fichas, origen) {
  const buenas = fichas.filter((f) => coincide(extraida, f));
  if (!buenas.length) return null;
  const identidad = (f) => `${normalizar(f.authors)}|${f.year ?? ''}`;
  // Dos tesis indistinguibles por título: no elegir a ciegas una de ellas.
  if (new Set(buenas.map(identidad)).size > 1) return null;
  const f = buenas.sort((a, b) => similitud(extraida.titulo, b.title) - similitud(extraida.titulo, a.title))[0];
  const item = String(f.itemType ?? '').toLowerCase();
  const tipo = /thesis/.test(item) ? 'tesis' : /book/.test(item) ? 'libro' : /report/.test(item) ? 'informe' : /article/.test(item) ? 'articulo' : extraida.tipo;
  const grado = /doctoral/.test(item) ? 'doctorado' : /master/.test(item) ? 'maestria' : /bachelor/.test(item) ? 'pregrado' : '';
  return {
    titulo: String(f.title).slice(0, 500), autores: String(f.authors ?? '').slice(0, 500),
    anio: f.year ?? null, fuente: String(f.source ?? '').slice(0, 300), tipo, grado,
    url: urlSegura(f.url), origen,
  };
}

async function identificarUna(extraida) {
  // Nunca interpolar sintaxis de consulta de un archivo en VuFind.
  const consulta = `"${normalizar(extraida.titulo)}"`;
  for (const [origen, buscar] of [
    ['ALICIA', () => alicia.buscar({ consulta }, { reintentar: false })],
    ['LA Referencia', () => lareferencia.buscar({ consulta })],
    ...(extraida.tipo !== 'tesis' ? [['OpenAlex', () => openalex.buscarPorTitulo(normalizar(extraida.titulo))]] : []),
  ]) {
    try {
      const resultado = await buscar();
      const ficha = mejor(extraida, Array.isArray(resultado) ? resultado : resultado.fichas ?? resultado.resultados ?? [], origen);
      if (ficha) return ficha;
    } catch {
      // Una caída no convierte la carátula en un error ni impide guardar.
    }
  }
  return null;
}

/** Tope compartido por todas las llamadas, incluso de varios usuarios. */
let activas = 0;
const cola = [];
async function conTurno(trabajo) {
  if (activas >= CONCURRENCIA) await new Promise((resolve) => cola.push(resolve));
  else activas++;
  try { return await trabajo(); }
  finally {
    const siguiente = cola.shift();
    if (siguiente) siguiente();
    else activas--;
  }
}

async function identificar(fuentes) {
  return Promise.all(fuentes.map((f) => conTurno(() => identificarUna(f))));
}

module.exports = { identificar, coincide, similitud, UMBRAL, CONCURRENCIA };

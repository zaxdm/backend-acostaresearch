'use strict';

/**
 * Los memos: las notas del investigador sobre un código, una entrevista o el
 * análisis entero.
 *
 * Es el cuaderno de campo que pide cualquier metodología cualitativa —«por qué
 * junté estos dos códigos», «esto se repite en las tres mujeres»— y lo que el
 * jurado pregunta cuando quiere ver que detrás de las categorías hubo un
 * proceso. En ATLAS.ti son el «Administrador de memos».
 *
 * Todo puro: recibe lo guardado y devuelve lo nuevo. Un memo es de quien lo
 * escribe; aquí no se interpreta, solo se guarda al lado de lo que comenta.
 */

const { claveDe, CodificacionNoValida } = require('./cualitativo.codificacion');

const MAXIMO_MEMOS = 200;
const MAXIMO_CARACTERES = 4_000;

const TIPOS = new Set(['codigo', 'entrevista', 'analisis']);

/** «Sobre qué es», en palabras, para enseñarlo. */
function sobreQue(memo) {
  if (memo.tipo === 'codigo') return `Código «${memo.sobre}»`;
  if (memo.tipo === 'entrevista') return `Entrevista ${memo.sobre}`;
  return 'El análisis';
}

/**
 * Guarda un memo. `sobre` es el nombre del código o el id de la entrevista, y
 * no hace falta con «analisis».
 *
 * Lanza `CodificacionNoValida` si el código o la entrevista no existen: un memo
 * sobre algo que no está se pierde sin que nadie lo note.
 */
function escribir(memos, { tipo, sobre, texto }, { codificacion, entrevistas }) {
  const lista = structuredClone(memos ?? []);
  const cuerpo = String(texto ?? '').trim();
  const errores = [];

  if (!TIPOS.has(tipo)) errores.push('El memo va sobre «codigo», «entrevista» o «analisis».');
  if (cuerpo === '') errores.push('El memo está vacío.');
  if (cuerpo.length > MAXIMO_CARACTERES) {
    errores.push(`El memo pasa de ${MAXIMO_CARACTERES} caracteres; resúmelo o escribe dos.`);
  }
  if (lista.length >= MAXIMO_MEMOS) errores.push(`Ya hay ${MAXIMO_MEMOS} memos, que es el máximo.`);

  let referencia = null;
  if (tipo === 'codigo') {
    const codigo = (codificacion?.codigos ?? []).find((c) => claveDe(c.nombre) === claveDe(sobre));
    if (codigo) referencia = codigo.nombre;
    else errores.push(`No hay ningún código «${String(sobre ?? '').trim()}».`);
  } else if (tipo === 'entrevista') {
    const entrevista = (entrevistas ?? []).find((e) => e.id === String(sobre ?? '').toUpperCase());
    if (entrevista) referencia = entrevista.id;
    else errores.push(`No hay ninguna entrevista ${String(sobre ?? '').trim()}.`);
  }

  if (errores.length > 0) throw new CodificacionNoValida(errores);

  const memo = {
    id: `m${(lista.reduce((max, m) => Math.max(max, Number(String(m.id).slice(1)) || 0), 0) || 0) + 1}`,
    tipo,
    sobre: referencia,
    texto: cuerpo,
    escritoAt: new Date().toISOString(),
  };
  return { memos: [...lista, memo], memo };
}

/** Quita un memo por su número. Lanza si no existe. */
function quitar(memos, id) {
  const lista = memos ?? [];
  const buscado = String(id ?? '').trim().toLowerCase();
  const memo = lista.find((m) => m.id === buscado || m.id === `m${buscado.replace(/^m/, '')}`);
  if (!memo) throw new CodificacionNoValida([`No hay ningún memo ${String(id ?? '').trim()}.`]);
  return { memos: lista.filter((m) => m !== memo), memo };
}

/** Los memos de algo, o todos. `sobre` sin `tipo` no filtra. */
function filtrar(memos, { tipo, sobre } = {}) {
  let lista = memos ?? [];
  if (tipo) lista = lista.filter((m) => m.tipo === tipo);
  if (tipo && sobre) {
    const buscado = tipo === 'entrevista' ? String(sobre).toUpperCase() : claveDe(sobre);
    lista = lista.filter((m) => (tipo === 'entrevista' ? m.sobre === buscado : claveDe(m.sobre) === buscado));
  }
  return lista;
}

/** Al renombrar o juntar un código, sus memos lo siguen. */
function renombrarCodigo(memos, de, a) {
  return (memos ?? []).map((m) =>
    m.tipo === 'codigo' && claveDe(m.sobre) === claveDe(de) ? { ...m, sobre: a } : m,
  );
}

/** Al quitar una entrevista o un código, sus memos se quedan como del análisis. */
function soltar(memos, { tipo, sobre }) {
  return (memos ?? []).map((m) => {
    const suyo =
      m.tipo === tipo &&
      (tipo === 'entrevista' ? m.sobre === sobre : claveDe(m.sobre) === claveDe(sobre));
    return suyo ? { ...m, tipo: 'analisis', sobre: null, texto: `[${sobreQue(m)}, ya borrado] ${m.texto}` } : m;
  });
}

module.exports = { escribir, quitar, filtrar, renombrarCodigo, soltar, sobreQue, MAXIMO_MEMOS, MAXIMO_CARACTERES };

'use strict';

/**
 * Qué formatos de la biblioteca son de la universidad que dijo el tesista.
 *
 * El tesista la dice como la dice: «UCV», «la César Vallejo», «Universidad
 * Nacional de Trujillo», «unt». Se compara sin tildes ni mayúsculas, y sin las
 * palabras que llevan todas («universidad», «de», «la»…): así «César Vallejo»
 * encuentra «Universidad César Vallejo». Una sigla («UCV») solo encuentra lo
 * que la tiene escrita en sus otros nombres, porque adivinar siglas confunde
 * universidades (UNT es Trujillo y también Tumbes para alguien).
 *
 * Si coinciden varias, se devuelven todas: Claude le da a elegir. Nada de aquí
 * toca la base.
 */

/** Las palabras que no distinguen a una universidad de otra. */
const VACIAS = new Set([
  'universidad', 'univ', 'u', 'de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'en',
]);

const GRADOS = Object.freeze(['pregrado', 'posgrado', 'cualquiera']);

/** «Universidad César Vallejo» → «universidad cesar vallejo». */
function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    // El rango de las tildes, por código, como en `project.esquema`.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Las palabras que sí distinguen, sin repetir. */
function palabras(texto) {
  return [...new Set(normalizar(texto).split(' ').filter((p) => p && !VACIAS.has(p)))];
}

/** Los otros nombres de la ficha, de la lista con comas. */
function listaDeAlias(alias) {
  return String(alias ?? '')
    .split(/[,;\n]/)
    .map((a) => a.trim())
    .filter(Boolean);
}

/** Todos los nombres con que se puede encontrar un formato. */
function nombresDe(fila) {
  return [fila.universidad, ...listaDeAlias(fila.alias)].filter((n) => normalizar(n));
}

/**
 * ¿Lo que dijo el tesista nombra a esta universidad?
 *
 * Igual a uno de sus nombres, o todas sus palabras dentro de uno de ellos
 * («cesar vallejo» dentro de «universidad cesar vallejo»). «Trujillo» a secas
 * encuentra todas las que lo llevan en el nombre: por eso, con varias, se
 * pregunta.
 */
function coincide(fila, consulta) {
  const pedida = normalizar(consulta);
  const suyas = palabras(consulta);
  if (!pedida) return false;
  return nombresDe(fila).some((nombre) => {
    if (normalizar(nombre) === pedida) return true;
    if (suyas.length === 0) return false;
    const delNombre = new Set(palabras(nombre));
    // Una sola palabra corta (una sigla) tiene que ser el nombre entero: «ucv»
    // no puede encontrar «Universidad UCV Satelital» por contenerla.
    if (suyas.length === 1 && suyas[0].length <= 4) return false;
    return suyas.every((p) => delNombre.has(p));
  });
}

/**
 * Los formatos de esa universidad, para ese grado si lo dijo.
 *
 * Un formato «cualquiera» vale para los dos grados. El orden: primero los del
 * grado pedido, luego los generales, y dentro, los más usados.
 */
function buscar(filas, { universidad, grado = null } = {}) {
  const deEsa = filas.filter((f) => coincide(f, universidad));
  const conGrado = grado && GRADOS.includes(grado) && grado !== 'cualquiera'
    ? deEsa.filter((f) => f.grado === grado || f.grado === 'cualquiera')
    : deEsa;
  return conGrado.sort(
    (a, b) =>
      Number(b.grado === grado) - Number(a.grado === grado) || (b.usos ?? 0) - (a.usos ?? 0),
  );
}

/** «Universidad César Vallejo · Facultad de Derecho · posgrado», para las opciones. */
function etiqueta(fila) {
  return [
    fila.universidad,
    fila.facultad,
    fila.grado && fila.grado !== 'cualquiera' ? fila.grado : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

module.exports = { GRADOS, normalizar, palabras, listaDeAlias, coincide, buscar, etiqueta };

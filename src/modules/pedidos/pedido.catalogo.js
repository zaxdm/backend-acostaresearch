'use strict';

const { AREAS, METODOS } = require('../asesores/asesor.catalogo');

/**
 * Lo que se puede elegir al mandar un capítulo a revisar.
 *
 * Las áreas y los enfoques son LOS MISMOS que los de la ficha del asesor, y se
 * importan de allí en vez de copiarse. Es lo que permite mirar un pedido y
 * saber a quién se le puede dar: dos listas parecidas pero escritas aparte
 * acaban divergiendo, y el día que diverjan no habrá asesor que encaje con
 * ningún pedido y nadie sabrá por qué.
 */

/** Qué parte de la tesis manda. */
const CAPITULOS = Object.freeze({
  PROYECTO: 'Proyecto de tesis (capítulos I a III)',
  CAP1: 'Capítulo I — Introducción y problema',
  CAP2: 'Capítulo II — Marco teórico',
  CAP3: 'Capítulo III — Metodología',
  CAP4: 'Capítulo IV — Resultados',
  CAP5: 'Capítulo V — Discusión y conclusiones',
  COMPLETA: 'Tesis completa',
});

/**
 * Nivel del trabajo.
 *
 * No es un dato de adorno: decide quién puede revisarlo. Un bachiller no
 * observa la metodología de una tesis de maestría, y el grado del asesor está
 * en su ficha justo para poder cruzarlo con esto.
 */
const NIVELES = Object.freeze({
  PREGRADO: 'Pregrado',
  MAESTRIA: 'Maestría',
  DOCTORADO: 'Doctorado',
});

/** Cómo se lee un código guardado. Devuelve el propio código si ya no existe. */
const nombreDe = (catalogo, codigo) => catalogo[codigo] ?? codigo;

/** Las listas que el formulario necesita para pintarse. */
function catalogos() {
  const lista = (catalogo) =>
    Object.entries(catalogo).map(([codigo, nombre]) => ({ codigo, nombre }));

  return {
    areas: lista(AREAS),
    metodos: lista(METODOS),
    capitulos: lista(CAPITULOS),
    niveles: lista(NIVELES),
  };
}

module.exports = { CAPITULOS, NIVELES, AREAS, METODOS, nombreDe, catalogos };

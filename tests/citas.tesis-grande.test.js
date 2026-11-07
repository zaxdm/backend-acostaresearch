'use strict';

/**
 * Una tesis con cientos de citas se arma rápido y sin perder nada.
 *
 * Hasta el 7-nov las citas se procesaban de una en una y citeproc volvía a
 * registrar las fuentes en cada llamada: una tesis real de 373 citas dejaba el
 * servidor parado 20 segundos, y el conector daba 502 a todos los demás
 * alumnos. Ahora van todas juntas al final (`rebuildProcessorState`).
 *
 * Lo que una cita cambia por las demás —«2020a/2020b», la nota corta de
 * Chicago— tiene que seguir saliendo: es justo lo que se resolvía al ir de una
 * en una.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const csl = require('../src/modules/projects/project.csl');

const clave = (n) => `AR${n.toString(16).toUpperCase().padStart(8, '0')}`;

const APELLIDOS = ['Pérez', 'García', 'Quispe', 'Torres', 'Rojas', 'Flores', 'Mendoza', 'Vargas', 'Castillo', 'Huamán'];

const fuentes = Array.from({ length: 60 }, (_, i) => ({
  ref: clave(i + 1),
  itemType: 'journalArticle',
  title: `Estudio número ${i + 1} sobre gestión educativa`,
  authors:
    i % 3 === 0
      ? `${APELLIDOS[i % 10]}, A.; ${APELLIDOS[(i + 3) % 10]}, B.; ${APELLIDOS[(i + 5) % 10]}, C.`
      : `${APELLIDOS[i % 10]}, J.${i % 2 ? `; ${APELLIDOS[(i + 1) % 10]}, M.` : ''}`,
  year: 2015 + (i % 9),
  source: 'Revista Peruana de Educación',
  volume: String(i + 1),
  pages: `${i + 1}-${i + 20}`,
}));

// Mismo autor y mismo año: APA tiene que escribir 2020a y 2020b.
const GEMELA_A = { ...fuentes[0], ref: 'ARAAAAAAA1', authors: 'Salazar, R.', year: 2020, title: 'Primera obra' };
const GEMELA_B = { ...fuentes[0], ref: 'ARAAAAAAA2', authors: 'Salazar, R.', year: 2020, title: 'Segunda obra' };

const porClave = new Map([...fuentes, GEMELA_A, GEMELA_B].map((f) => [f.ref, f]));

/** Un capítulo con 400 citas: normales, narrativas, con página y de dos fuentes. */
function capituloLargo() {
  const frases = [];
  for (let i = 0; i < 400; i += 1) {
    const a = fuentes[(i * 7) % fuentes.length].ref;
    const b = fuentes[(i * 11 + 3) % fuentes.length].ref;
    if (i % 5 === 0) frases.push(`Según lo revisado [${a}:n] la gestión mejora.`);
    else if (i % 5 === 1) frases.push(`Los datos lo confirman [${a}][${b}].`);
    else if (i % 5 === 2) frases.push(`Se cita textualmente [${a}:p. ${i}].`);
    else frases.push(`La evidencia es amplia [${a}].`);
  }
  return frases.join(' ');
}

test('una tesis de 400 citas se arma en pocos segundos', () => {
  const inicio = Date.now();
  const r = csl.renderizar({ norma: 'apa', idioma: 'es-ES', porClave, capitulos: [{ texto: capituloLargo() }] });
  const ms = Date.now() - inicio;

  assert.equal(r.citas.size, 400);
  // Cada cita con su texto: ninguna se quedó sin procesar.
  for (const cita of r.citas.values()) assert.notEqual(cita.texto, '', `cita ${cita.id} vacía`);
  assert.equal(r.bibliografia.entradas.length, fuentes.length);
  // Con el método de antes, 47 s en un equipo normal; ahora 1,5 s. El margen es
  // amplio porque la batería entera corre en paralelo y lo frena.
  assert.ok(ms < 20_000, `tardó ${ms} ms`);
});

test('APA: dos obras del mismo autor y año salen 2020a y 2020b aunque la segunda llegue después', () => {
  const r = csl.renderizar({
    norma: 'apa',
    idioma: 'es-ES',
    porClave,
    capitulos: [{ texto: 'Primero [ARAAAAAAA1]. Luego [ARAAAAAAA2].' }],
  });

  // La primera cita cambia por culpa de la segunda: es lo que hay que conservar.
  assert.equal(r.citas.get(1).texto, '(Salazar, 2020a)');
  assert.equal(r.citas.get(2).texto, '(Salazar, 2020b)');
});

test('APA: la narrativa escribe los autores con «y» y no repite el nombre', () => {
  const r = csl.renderizar({
    norma: 'apa',
    idioma: 'es-ES',
    porClave,
    capitulos: [{ texto: `Como proponen [${fuentes[1].ref}:n] y también García y Quispe [${fuentes[1].ref}].` }],
  });

  assert.equal(r.citas.get(1).antes[0].texto, 'García y Quispe ');
  assert.equal(r.citas.get(1).texto, '(2016)');
  // La segunda ya traía los autores delante: no se vuelven a escribir.
  assert.deepEqual(r.citas.get(2).antes, []);
  assert.equal(r.citas.get(2).texto, '(2016)');
});

test('Chicago notas: la segunda cita de la misma fuente sale en forma corta', () => {
  const r = csl.renderizar({
    norma: 'chicago-notes-bibliography',
    idioma: 'es-ES',
    porClave,
    capitulos: [{ texto: `Uno [${fuentes[2].ref}]. Dos [${fuentes[2].ref}].` }],
  });

  // Chicago 18.ª ya no usa «Ibid.»: la segunda vez va la forma corta, que solo
  // se sabe cuando la primera ya está registrada.
  assert.match(r.citas.get(1).texto, /Revista Peruana de Educación/);
  assert.equal(r.citas.get(2).texto, 'Quispe, «Estudio número 3 sobre gestión educativa».');
});

'use strict';

/**
 * El respaldo de cada afirmación.
 *
 * Un detector que señala de más se acaba ignorando entero, y entonces tampoco
 * señala lo que importa. Por eso la mitad de estas pruebas comprueba que NO
 * salte: prosa normal, frases cortas, encabezados.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const evidencia = require('../src/modules/projects/project.evidencia');

const FUENTES = new Map([
  ['AR97D22F86', { ref: 'AR97D22F86', title: 'Deserción universitaria', authors: 'García, M.' }],
]);

function revisar(texto) {
  return evidencia.revisarCapitulo({ titulo: 'Capítulo', texto }, FUENTES);
}

test('una afirmación con clave cuenta como respaldada, y dice cuál', () => {
  const r = revisar(
    'Diversos estudios demuestran que la deserción alcanza el 30% en el primer ciclo [AR97D22F86].',
  );

  assert.equal(r.conRespaldo.length, 1);
  assert.equal(r.conRespaldo[0].fuentes[0].titulo, 'Deserción universitaria');
  assert.equal(r.sinRespaldo.length, 0);
});

test('una cita escrita a mano se señala aparte, que es lo grave', () => {
  // Parece respaldada y no lo está: nadie ha comprobado que exista.
  const r = revisar(
    'Diversos estudios demuestran que la deserción alcanza el 30% en el primer ciclo (García, 2024).',
  );

  assert.equal(r.citasAMano.length, 1);
  assert.equal(r.sinRespaldo.length, 0, 'no se cuenta dos veces');
  assert.equal(r.conRespaldo.length, 0);
});

test('una afirmación con cifra y sin nada se marca sin fuente', () => {
  const r = revisar('La deserción en las universidades públicas de Lima alcanza el 42% cada año.');

  assert.equal(r.sinRespaldo.length, 1);
});

test('un verbo de reporte sin fuente también se marca', () => {
  const r = revisar('Diversos autores señalan que el acompañamiento tutorial reduce la deserción.');

  assert.equal(r.sinRespaldo.length, 1);
});

test('la prosa normal no se marca', () => {
  // La mitad de una tesis son frases que no afirman nada atribuible.
  const r = revisar(
    'En este capítulo se presentan los antecedentes de la investigación y se organiza la ' +
      'revisión en tres apartados, siguiendo el orden de los objetivos específicos.',
  );

  assert.equal(r.sinRespaldo.length, 0);
  assert.equal(r.citasAMano.length, 0);
});

test('los encabezados no son afirmaciones', () => {
  const r = revisar('## Antecedentes internacionales sobre deserción universitaria');

  assert.equal(r.sinRespaldo.length, 0);
});

test('una línea corta no se marca aunque lleve un número', () => {
  // Un pie de tabla o una entrada de lista no da para afirmar nada.
  const r = revisar('Tabla 3. El 40%.');

  assert.equal(r.sinRespaldo.length, 0);
});

test('un paréntesis con números que no es una cita no se confunde', () => {
  const r = revisar(
    'El instrumento se aplicó en dos momentos distintos del semestre académico (marzo y julio), ' +
      'siguiendo el cronograma aprobado por la escuela profesional correspondiente.',
  );

  assert.equal(r.citasAMano.length, 0);
});

test('una clave que no corresponde a ninguna fuente se ve como tal', () => {
  const r = revisar('Se ha demostrado que el acompañamiento reduce la deserción [ARDEADBEEF].');

  assert.equal(r.conRespaldo.length, 1);
  assert.equal(r.conRespaldo[0].fuentes[0].existe, false);
  assert.equal(r.conRespaldo[0].fuentes[0].titulo, null);
});

test('se cuenta por capítulos y se suma', () => {
  const informe = evidencia.revisar(
    [
      { titulo: 'Capítulo II', texto: 'La mayoría abandona el primer año, según la evidencia disponible.' },
      { titulo: 'Capítulo IV', texto: 'El 30% de la muestra abandonó durante el periodo estudiado [AR97D22F86].' },
    ],
    FUENTES,
  );

  assert.equal(informe.capitulos.length, 2);
  assert.equal(informe.total.sinRespaldo, 1);
  assert.equal(informe.total.conRespaldo, 1);
});

test('una frase larguísima se recorta para poder enseñarla', () => {
  const larga = `Diversos estudios demuestran que ${'la deserción universitaria '.repeat(20)}.`;
  const r = revisar(larga);

  assert.ok(r.sinRespaldo[0].frase.length <= 205);
  assert.match(r.sinRespaldo[0].frase, /…$/);
});

test('la prosa de estructura no se marca, aunque nombre la literatura', () => {
  // Salió en la primera prueba contra el servidor: esta frase saltaba como
  // «sin fuente» y no afirma nada. Una tesis está llena de frases así, y un
  // detector que marca la mitad del capítulo se cierra y no se vuelve a abrir.
  const r = revisar(
    'En este capítulo se organiza la revisión de la literatura en tres apartados, ' +
      'siguiendo el orden de los objetivos específicos planteados.',
  );

  assert.equal(r.sinRespaldo.length, 0);
});

test('pero atribuir algo a la literatura sí se marca', () => {
  const r = revisar(
    'Según la literatura reciente, el acompañamiento tutorial reduce el abandono en el primer año.',
  );

  assert.equal(r.sinRespaldo.length, 1);
});

test('«diversos autores señalan» sigue saltando por el verbo', () => {
  const r = revisar(
    'Diversos autores coinciden y señalan que el primer ciclo concentra la mayor parte del abandono.',
  );

  assert.equal(r.sinRespaldo.length, 1);
});

'use strict';

/**
 * Las citas del Word.
 *
 * Lo que se prueba es que la cita del texto y la entrada de la bibliografía
 * salgan siempre de la misma ficha, y que una cita que no se puede resolver se
 * vea. Lo segundo importa tanto como lo primero: una afirmación sin respaldo
 * disfrazada de afirmación con respaldo es peor que una cita rota a la vista.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const citas = require('../src/modules/projects/project.citas');

const GARCIA = {
  ref: 'AR97D22F86',
  authors: 'García, M.; Torres, L.; Quispe, A.',
  year: 2024,
  title: 'Deserción universitaria en el primer ciclo',
  source: 'Revista Peruana de Educación',
  doi: '10.1234/rpe.2024.11',
};

const TINTO = {
  ref: 'AR11112222',
  authors: 'Tinto, V.',
  year: 1975,
  title: 'Dropout from higher education',
  source: 'Review of Educational Research',
  doi: null,
  url: 'https://example.org/tinto',
};

test('tres autores o más se citan con «et al.»', () => {
  assert.equal(citas.citaEnElTexto(GARCIA), '(García et al., 2024)');
});

test('un autor solo va con su apellido', () => {
  assert.equal(citas.citaEnElTexto(TINTO), '(Tinto, 1975)');
});

test('dos autores van con «y», que es como se escribe en español', () => {
  const dos = { ...GARCIA, authors: 'García, M.; Torres, L.' };
  assert.equal(citas.citaEnElTexto(dos), '(García y Torres, 2024)');
});

test('sin autor y sin año, la cita sigue siendo legible', () => {
  assert.equal(citas.citaEnElTexto({ authors: null, year: null }), '(Anónimo, s. f.)');
});

test('las marcas del texto se cambian por la cita en APA', () => {
  const porClave = new Map([[GARCIA.ref, GARCIA]]);
  const r = citas.resolver('La deserción crece [AR97D22F86].', porClave);

  assert.equal(r.texto, 'La deserción crece (García et al., 2024).');
  assert.equal(r.usadas.size, 1);
  assert.deepEqual(r.perdidas, []);
});

test('una cita que no corresponde a ninguna fuente se ve, no se borra', () => {
  // Borrarla dejaría una afirmación sin respaldo con aspecto de tenerlo, que es
  // justo lo que este módulo existe para evitar.
  const r = citas.resolver('Algo se afirma [ARDEADBEEF].', new Map());

  assert.match(r.texto, /CITA SIN LOCALIZAR/);
  assert.ok(!r.texto.includes('ARDEADBEEF'), 'el corchete raro no llega a la tesis');
  assert.deepEqual(r.perdidas, ['ARDEADBEEF']);
});

test('la misma fuente citada cuatro veces aparece una vez en la lista', () => {
  const porClave = new Map([[GARCIA.ref, GARCIA]]);
  const r = citas.resolver(
    'Uno [AR97D22F86]. Dos [AR97D22F86]. Tres [AR97D22F86]. Cuatro [AR97D22F86].',
    porClave,
  );

  assert.equal(r.usadas.size, 1);
  assert.equal(citas.bibliografia([...r.usadas.values()]).length, 1);
});

test('la bibliografía va en orden alfabético español', () => {
  const lista = citas.bibliografia([TINTO, GARCIA]);

  assert.match(lista[0], /^García/);
  assert.match(lista[1], /^Tinto/);
});

test('la entrada lleva el DOI cuando lo hay, y la URL cuando no', () => {
  const [conDoi] = citas.bibliografia([GARCIA]);
  assert.match(conDoi, /https:\/\/doi\.org\/10\.1234\/rpe\.2024\.11/);

  const [conUrl] = citas.bibliografia([TINTO]);
  assert.match(conUrl, /https:\/\/example\.org\/tinto/);
});

test('el texto que no lleva marcas se queda exactamente igual', () => {
  const original = 'Un párrafo normal, con corchetes [de otra cosa] y un [123] cualquiera.';
  const r = citas.resolver(original, new Map());

  assert.equal(r.texto, original);
  assert.deepEqual(r.perdidas, []);
});

test('se recogen las claves de un texto sin repetirlas', () => {
  const claves = citas.clavesDe('[AR97D22F86] y [AR11112222] y otra vez [AR97D22F86]');

  assert.deepEqual(claves.sort(), ['AR11112222', 'AR97D22F86']);
});

// ── La clave escrita en minúsculas ──────────────────────────────────────────
//
// Las herramientas dan siempre la clave en mayúsculas, pero un modelo la
// normaliza de vez en cuando. En minúsculas la marca no casaba, y eso falla
// PEOR que una clave equivocada: salía impresa tal cual en el capítulo y la
// fuente no entraba en las referencias, sin dejar rastro en ninguna parte. Una
// clave equivocada, al menos, deja «[CITA SIN LOCALIZAR]» a la vista y se anota
// en «perdidas» para que el repaso la cante.

test('una clave en minúsculas se cita igual que en mayúsculas', () => {
  const porClave = new Map([[GARCIA.ref, GARCIA]]);

  const mayusculas = citas.resolver('La deserción crece [AR97D22F86].', porClave);
  const minusculas = citas.resolver('La deserción crece [ar97d22f86].', porClave);

  assert.equal(minusculas.texto, mayusculas.texto);
  assert.deepEqual(minusculas.perdidas, []);
});

test('y cuenta como la MISMA fuente, no como dos', () => {
  // Si contara dos, la lista de referencias tendría la misma entrada repetida.
  const porClave = new Map([[GARCIA.ref, GARCIA]]);
  const { usadas } = citas.resolver('Uno [AR97D22F86] y otro [ar97d22f86].', porClave);

  assert.equal(usadas.size, 1);
  assert.ok(usadas.has('AR97D22F86'), 'se guarda en su forma canónica, en mayúsculas');
});

test('las claves de un texto se devuelven siempre en mayúsculas', () => {
  assert.deepEqual(citas.clavesDe('Mezcla [ar97d22f86] y [AR97D22F86].'), ['AR97D22F86']);
});

test('una clave en minúsculas que NO existe sigue avisando', () => {
  const porClave = new Map([[GARCIA.ref, GARCIA]]);
  const { texto, perdidas } = citas.resolver('Alguien lo dice [ar99999999].', porClave);

  assert.match(texto, /CITA SIN LOCALIZAR/);
  assert.deepEqual(perdidas, ['AR99999999']);
});

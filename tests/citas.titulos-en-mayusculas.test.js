'use strict';

/**
 * Títulos que la revista depositó enteros en mayúsculas.
 *
 * E2E de tesis del 9-nov-2026: cuatro de las 42 referencias salían así
 * («ANÁLISIS PSICOMÉTRICO DEL INSTRUMENTO … DEL PERÚ»). APA pide el título en
 * tipo oración. Se prueba la función, la referencia por citeproc y el APA de
 * respaldo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const csl = require('../src/modules/projects/project.csl');
const citas = require('../src/modules/projects/project.citas');

const { tituloLegible } = citas;

test('un título en mayúsculas pasa a tipo oración, con los nombres propios y las siglas', () => {
  assert.equal(
    tituloLegible('ANÁLISIS DEL COMPROMISO LABORAL EN COLABORADORES DE GOBIERNOS LOCALES DE LA CIUDAD DE AREQUIPA, PERÚ'),
    'Análisis del compromiso laboral en colaboradores de gobiernos locales de la ciudad de Arequipa, Perú',
  );
  assert.equal(
    tituloLegible('ANÁLISIS PSICOMÉTRICO DEL INSTRUMENTO DE CLIMA ORGANIZACIONAL PARA EL PERSONAL DEL MINISTERIO DE SALUD DEL PERÚ'),
    'Análisis psicométrico del instrumento de clima organizacional para el personal del Ministerio de Salud del Perú',
  );
  assert.equal(
    tituloLegible('IMPACTO DEL COVID-19 EN LAS MYPES DE LA LIBERTAD'),
    'Impacto del COVID-19 en las MYPES de La Libertad',
  );
});

test('después de los dos puntos va mayúscula, y un país sin tilde se queda sin tilde', () => {
  assert.equal(
    tituloLegible('THE EFFECT OF ORGANIZATIONAL CLIMATE ON TURNOVER INTENTION: EVIDENCE FROM PUBLIC EMPLOYEES IN PERU'),
    'The effect of organizational climate on turnover intention: Evidence from public employees in Peru',
  );
});

test('un título con alguna minúscula, o muy corto, no se toca', () => {
  assert.equal(tituloLegible('Clima laboral y desempeño en la UGEL Trujillo'), 'Clima laboral y desempeño en la UGEL Trujillo');
  assert.equal(tituloLegible('eHealth in PERU'), 'eHealth in PERU');
  assert.equal(tituloLegible('SPSS BÁSICO'), 'SPSS BÁSICO');
  assert.equal(tituloLegible(null), '');
});

const ficha = {
  ref: 'AR00000010',
  authors: 'Becerra-Canales, B.; Solari-Bonifacio, C.',
  year: 2020,
  title: 'ANÁLISIS PSICOMÉTRICO DEL INSTRUMENTO DE CLIMA ORGANIZACIONAL DEL PERÚ',
  source: 'Revista Médica Panacea',
  itemType: 'journalArticle',
};

test('la referencia en APA (citeproc) sale en tipo oración', () => {
  const r = csl.renderizar({
    norma: 'apa',
    idioma: 'es-ES',
    porClave: new Map([[ficha.ref, ficha]]),
    capitulos: [{ texto: `Algo [${ficha.ref}].` }],
  });
  const entrada = r.bibliografia.entradas.map((e) => e.tramos.map((t) => t.texto).join('')).join('\n');
  assert.match(entrada, /Análisis psicométrico del instrumento de clima organizacional del Perú/);
  assert.doesNotMatch(entrada, /ANÁLISIS PSICOMÉTRICO/);
});

test('y en el APA de respaldo también', () => {
  const plano = citas.tramosDeBibliografia(ficha).map((t) => t.texto).join('');
  assert.match(plano, /Análisis psicométrico del instrumento de clima organizacional del Perú/);
});

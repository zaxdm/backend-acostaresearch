'use strict';

/**
 * Tres errores que vio un tesista en su Word el 8-nov-2026:
 *
 *   «Pizzán Tomanguillo et al. Pizzan-Tomanguillo et al. (2022)»  apellido repetido
 *   «(PALOMINO-FLORES et al., 2026)»                              apellido en mayúsculas
 *   «(Ministerio de la Producción (Produce), 2025)»               paréntesis dentro de otro
 *
 * Se prueban con la norma APA (citeproc) y con el APA de respaldo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const csl = require('../src/modules/projects/project.csl');
const citas = require('../src/modules/projects/project.citas');

const ficha = (ref, authors, year) => ({ ref, authors, year, title: 'Título', source: 'Revista', itemType: 'journalArticle' });

const porClave = new Map([
  ['AR00000001', ficha('AR00000001', 'Pizzan-Tomanguillo, A.; Gil, B.; Ruiz, C.', 2022)],
  ['AR00000002', ficha('AR00000002', 'PALOMINO-FLORES, J.; DE LA CRUZ, X.; McAdams, Z.', 2026)],
  ['AR00000003', ficha('AR00000003', 'Ministerio de la Producción (Produce)', 2025)],
]);

function enApa(texto) {
  const r = csl.renderizar({ norma: 'apa', idioma: 'es-ES', porClave, capitulos: [{ texto }] });
  const capitulo = r.textos[0].replace(citas.HUECO_RE, (_, n) => {
    const cita = r.citas.get(Number(n));
    return cita.antes.map((t) => t.texto).join('') + cita.texto;
  });
  const plano = (t) => t.replace(/ /g, ' ');
  return { capitulo: plano(capitulo), referencias: r.bibliografia.entradas.map((e) => plano(e.tramos.map((t) => t.texto).join(''))) };
}

const respaldo = (texto) => citas.resolver(texto, porClave).texto;

test('el apellido escrito con espacio no se repite si la ficha lo tiene con guion', () => {
  const texto = 'En el Perú, Pizzán Tomanguillo et al. [AR00000001:n] se';
  assert.equal(enApa(texto).capitulo, 'En el Perú, Pizzán Tomanguillo et al. (2022) se');
  assert.equal(respaldo(texto), 'En el Perú, Pizzán Tomanguillo et al. (2022) se');
});

test('el apellido en mayúsculas sale en minúsculas, en la cita y en las referencias', () => {
  const { capitulo, referencias } = enApa('empresas [AR00000002].');
  assert.equal(capitulo, 'empresas (Palomino-Flores et al., 2026).');
  assert.ok(referencias.some((r) => r.startsWith('Palomino-Flores, J., De la Cruz, X., & McAdams, Z. (2026)')));
  assert.equal(respaldo('empresas [AR00000002].'), 'empresas (Palomino-Flores et al., 2026).');
});

test('la sigla de la institución va entre corchetes en la cita y no en las referencias', () => {
  const { capitulo, referencias } = enApa('interno [AR00000003]. Según el Ministerio de la Producción [AR00000003:n] hay');
  assert.equal(capitulo, 'interno (Ministerio de la Producción [Produce], 2025). Según el Ministerio de la Producción [Produce] (2025) hay');
  assert.ok(referencias.some((r) => r.startsWith('Ministerio de la Producción. (2025)')));
  assert.equal(respaldo('interno [AR00000003].'), 'interno (Ministerio de la Producción [Produce], 2025).');
});

test('lo que ya estaba bien escrito no se toca', () => {
  assert.equal(citas.apellidoLegible('McAdams'), 'McAdams');
  assert.equal(citas.apellidoLegible('da Silva'), 'da Silva');
  assert.equal(citas.apellidoLegible('Ñ'), 'Ñ');
  assert.equal(citas.institucionConSigla('Organización Mundial de la Salud'), null);
  assert.equal(citas.nombreParaCita('OMS'), 'OMS');
});

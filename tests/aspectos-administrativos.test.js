'use strict';

/**
 * Los aspectos administrativos son del proyecto, no del informe final.
 *
 * Recursos, presupuesto, financiamiento y cronograma justifican que el estudio
 * se puede hacer. El Word los pone detrás de la Metodología mientras es el
 * proyecto y deja de imprimirlos en cuanto hay resultados, discusión o
 * conclusiones guardados, salvo que el esquema de su facultad los nombre.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const esquema = require('../src/modules/projects/project.esquema');
const { faseDelTitulo } = require('../src/modules/projects/project.avance');

// Como sale del catálogo: la fase nueva cae al final por su `orden`.
const CATALOGO = [
  { code: 'tema-y-delimitacion', displayName: '1 · Tema y delimitación' },
  { code: 'problema-y-objetivos', displayName: '2 · Capítulo I · Problema y objetivos' },
  { code: 'marco-teorico', displayName: '3 · Capítulo II · Marco teórico' },
  { code: 'metodologia', displayName: '4 · Capítulo III · Metodología' },
  { code: 'instrumento-investigacion', displayName: '5 · Instrumento' },
  { code: 'analisis-datos-rstudio', displayName: '7 · Capítulo IV · Resultados' },
  { code: 'discusion', displayName: '8 · Capítulo V · Discusión' },
  { code: 'conclusiones-abstract', displayName: '9 · Capítulo VI · Conclusiones' },
  { code: 'aspectos-administrativos', displayName: '4B · Aspectos administrativos' },
];

const PROYECTO = new Set(['problema-y-objetivos', 'marco-teorico', 'metodologia', 'aspectos-administrativos']);

const codigos = (capitulos) => capitulos.map((c) => c.partes[0]);

test('en el proyecto, sin esquema, sale justo detrás de la Metodología', () => {
  const { capitulos } = esquema.capitulosDelDocumento({ esquema: null, catalogo: CATALOGO, conTexto: PROYECTO });
  const lista = codigos(capitulos);
  assert.equal(lista[lista.indexOf('metodologia') + 1], 'aspectos-administrativos');
});

test('con resultados guardados ya es el informe final y no se imprime', () => {
  for (const code of ['analisis-datos-rstudio', 'discusion', 'conclusiones-abstract']) {
    const conTexto = new Set([...PROYECTO, code]);
    const { capitulos } = esquema.capitulosDelDocumento({ esquema: null, catalogo: CATALOGO, conTexto });
    assert.ok(!codigos(capitulos).includes('aspectos-administrativos'), code);
  }
});

test('lo que recorre lo escrito la sigue viendo aunque no se imprima', () => {
  const conTexto = new Set([...PROYECTO, 'analisis-datos-rstudio']);
  const { capitulos } = esquema.capitulosDelDocumento({
    esquema: null,
    catalogo: CATALOGO,
    conTexto,
    incluirFasesDeTrabajo: true,
  });
  assert.ok(codigos(capitulos).includes('aspectos-administrativos'));
});

test('si el esquema de su facultad la nombra, sale también en el informe final', () => {
  const suyo = esquema.normalizar(
    {
      capitulos: [
        { titulo: 'CAPÍTULO III: METODOLOGÍA', de: ['metodologia'] },
        { titulo: 'CAPÍTULO IV: ASPECTOS ADMINISTRATIVOS', de: ['aspectos-administrativos'] },
        { titulo: 'CAPÍTULO V: RESULTADOS', de: ['analisis-datos-rstudio'] },
      ],
    },
    { catalogo: CATALOGO },
  );
  const conTexto = new Set([...PROYECTO, 'analisis-datos-rstudio']);
  const { capitulos } = esquema.capitulosDelDocumento({ esquema: suyo, catalogo: CATALOGO, conTexto });
  assert.ok(capitulos.some((c) => c.partes.includes('aspectos-administrativos')));
});

test('con un esquema que no la nombra, sobra en el proyecto y desaparece en el informe', () => {
  const suyo = esquema.normalizar({ capitulos: [{ titulo: 'CAPÍTULO III', de: ['metodologia'] }] }, { catalogo: CATALOGO });

  const enProyecto = esquema.capitulosDelDocumento({ esquema: suyo, catalogo: CATALOGO, conTexto: PROYECTO });
  assert.ok(enProyecto.sobrantes.some((s) => s.code === 'aspectos-administrativos'));

  const conTexto = new Set([...PROYECTO, 'discusion']);
  const enInforme = esquema.capitulosDelDocumento({ esquema: suyo, catalogo: CATALOGO, conTexto });
  assert.ok(!enInforme.sobrantes.some((s) => s.code === 'aspectos-administrativos'));
});

test('un Word subido con «CAPÍTULO IV: ASPECTOS ADMINISTRATIVOS» no cae en Resultados', () => {
  const conLaFase = CATALOGO.map((s) => s.code);
  assert.equal(
    faseDelTitulo('CAPÍTULO IV: ASPECTOS ADMINISTRATIVOS', { codigos: conLaFase, tipo: 'tesis' }),
    'aspectos-administrativos',
  );
  assert.equal(faseDelTitulo('IV. Recursos y presupuesto', { codigos: conLaFase, tipo: 'tesis' }), 'aspectos-administrativos');

  // Sin la fase en el catálogo, no es de nadie: antes se la llevaba Resultados por el número.
  const sinLaFase = conLaFase.filter((c) => c !== 'aspectos-administrativos');
  assert.equal(faseDelTitulo('CAPÍTULO IV: ASPECTOS ADMINISTRATIVOS', { codigos: sinLaFase, tipo: 'tesis' }), null);
  assert.equal(faseDelTitulo('CAPÍTULO IV: RESULTADOS', { codigos: sinLaFase, tipo: 'tesis' }), 'analisis-datos-rstudio');
});

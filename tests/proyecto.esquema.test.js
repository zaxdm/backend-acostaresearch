'use strict';

/**
 * La estructura de capítulos de su facultad.
 *
 * El caso que hay que resolver es el de la UNSAAC, que no coincide con el
 * método en nada de esto: mete un Capítulo III de Hipótesis que el método no
 * tiene, corre Metodología al IV y junta Resultados con Discusión en el V. Lo
 * que se prueba aquí es que el Word sale con SU numeración, que un capítulo que
 * el método no tiene se puede escribir igual, y sobre todo que nada de esto
 * hace desaparecer texto que alguien escribió.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const esquema = require('../src/modules/projects/project.esquema');

const CATALOGO = [
  { code: 'problema-y-objetivos', displayName: '2 · Capítulo I · Problema y objetivos' },
  { code: 'marco-teorico', displayName: '3 · Capítulo II · Marco teórico' },
  { code: 'metodologia', displayName: '4 · Capítulo III · Metodología' },
  { code: 'analisis-datos-rstudio', displayName: '7 · Capítulo IV · Resultados' },
  { code: 'discusion', displayName: '8 · Capítulo V · Discusión' },
];

/** El de la UNSAAC, entero. */
const UNSAAC = [
  { titulo: 'CAPÍTULO I: PROBLEMA', de: ['problema-y-objetivos'] },
  { titulo: 'CAPÍTULO II: MARCO TEÓRICO', de: ['marco-teorico'] },
  { titulo: 'CAPÍTULO III: HIPÓTESIS', de: [] },
  { titulo: 'CAPÍTULO IV: METODOLOGÍA', de: ['metodologia'] },
  { titulo: 'CAPÍTULO V: RESULTADOS Y DISCUSIÓN', de: ['analisis-datos-rstudio', 'discusion'] },
];

const normalizar = (capitulos, opciones = {}) =>
  esquema.normalizar({ capitulos }, { catalogo: CATALOGO, ...opciones });

// ── Lo que se guarda ────────────────────────────────────────────────────────

test('el esquema de la UNSAAC se guarda entero, con su capítulo propio', () => {
  const guardado = normalizar(UNSAAC);

  assert.equal(guardado.capitulos.length, 5);
  // El de Hipótesis no sale de ninguna fase: es propio, y el servidor le pone
  // la clave. El asistente NO la manda, para que no cambie entre conversaciones.
  assert.deepEqual(guardado.capitulos[2], {
    titulo: 'CAPÍTULO III: HIPÓTESIS',
    clave: 'propio-capitulo-iii-hipotesis',
  });
  // Y el quinto junta dos fases, en el orden en que se mandaron.
  assert.deepEqual(guardado.capitulos[4].de, ['analisis-datos-rstudio', 'discusion']);
});

test('una fase inventada o repetida no se guarda, y se dice por qué', () => {
  assert.throws(
    () => normalizar([{ titulo: 'Capítulo I', de: ['capitulo-que-no-existe'] }]),
    (e) => e instanceof esquema.EsquemaNoValido && /capitulo-que-no-existe/.test(e.message),
  );

  assert.throws(
    () =>
      normalizar([
        { titulo: 'Capítulo I', de: ['metodologia'] },
        { titulo: 'Capítulo II', de: ['metodologia'] },
      ]),
    (e) => e instanceof esquema.EsquemaNoValido && /dos capítulos a la vez/.test(e.message),
  );
});

test('dos capítulos con el mismo título no valen: el índice saldría con dos entradas iguales', () => {
  assert.throws(
    () => normalizar([{ titulo: 'Capítulo I', de: ['metodologia'] }, { titulo: 'capítulo i', de: [] }]),
    (e) => e instanceof esquema.EsquemaNoValido && /dos capítulos titulados/.test(e.message),
  );
});

test('renombrar un capítulo propio que ya tenía texto no cambia su clave', () => {
  const antes = normalizar(UNSAAC);
  const conTexto = new Set(['propio-capitulo-iii-hipotesis']);

  const despues = normalizar(
    UNSAAC.map((c) => (c.titulo.includes('HIPÓTESIS') ? { ...c, titulo: 'CAPÍTULO III: HIPÓTESIS DE LA INVESTIGACIÓN' } : c)),
    { anterior: antes, conTexto },
  );

  // El título cambia; la clave no, o el texto guardado se quedaría huérfano.
  assert.equal(despues.capitulos[2].titulo, 'CAPÍTULO III: HIPÓTESIS DE LA INVESTIGACIÓN');
  assert.equal(despues.capitulos[2].clave, 'propio-capitulo-iii-hipotesis');
});

// ── Cómo se arma el documento ───────────────────────────────────────────────

test('los capítulos del Word salen en el orden del reglamento, con las fases fundidas', () => {
  const { capitulos, sobrantes } = esquema.capitulosDelDocumento({
    esquema: normalizar(UNSAAC),
    catalogo: CATALOGO,
    conTexto: new Set(CATALOGO.map((s) => s.code)),
  });

  assert.deepEqual(
    capitulos.map((c) => c.titulo),
    [
      'CAPÍTULO I: PROBLEMA',
      'CAPÍTULO II: MARCO TEÓRICO',
      'CAPÍTULO III: HIPÓTESIS',
      'CAPÍTULO IV: METODOLOGÍA',
      'CAPÍTULO V: RESULTADOS Y DISCUSIÓN',
    ],
  );
  // El capítulo fundido lee las dos fases, en orden.
  assert.deepEqual(capitulos[4].partes, ['analisis-datos-rstudio', 'discusion']);
  assert.equal(sobrantes.length, 0);
});

test('una fase con texto que el esquema no nombra sale igual, al final', () => {
  // Es la regla que más importa: el asistente va a mandar esquemas incompletos,
  // y un capítulo escrito no puede desaparecer del Word sin que nadie lo note.
  const parcial = normalizar([{ titulo: 'CAPÍTULO ÚNICO', de: ['metodologia'] }]);
  const { capitulos, sobrantes } = esquema.capitulosDelDocumento({
    esquema: parcial,
    catalogo: CATALOGO,
    conTexto: new Set(['metodologia', 'marco-teorico']),
  });

  assert.deepEqual(
    capitulos.map((c) => c.titulo),
    ['CAPÍTULO ÚNICO', '3 · Capítulo II · Marco teórico'],
  );
  assert.deepEqual(sobrantes.map((s) => s.code), ['marco-teorico']);
});

test('una fase sin texto que el esquema no nombra no ensucia el documento', () => {
  const parcial = normalizar([{ titulo: 'CAPÍTULO ÚNICO', de: ['metodologia'] }]);
  const { capitulos } = esquema.capitulosDelDocumento({
    esquema: parcial,
    catalogo: CATALOGO,
    conTexto: new Set(['metodologia']),
  });

  assert.deepEqual(capitulos.map((c) => c.titulo), ['CAPÍTULO ÚNICO']);
});

test('sin esquema, el documento sale con el catálogo tal cual, como siempre', () => {
  for (const vacio of [null, undefined, {}, { capitulos: [] }]) {
    const { capitulos } = esquema.capitulosDelDocumento({ esquema: vacio, catalogo: CATALOGO });
    assert.deepEqual(capitulos.map((c) => c.partes[0]), CATALOGO.map((s) => s.code));
  }
});

// ── Lo que lee el asistente ─────────────────────────────────────────────────

test('el capítulo propio se puede buscar por su clave, y una clave del método no cuela', () => {
  const guardado = normalizar(UNSAAC);

  assert.deepEqual(esquema.capituloPropio(guardado, 'propio-capitulo-iii-hipotesis'), {
    code: 'propio-capitulo-iii-hipotesis',
    displayName: 'CAPÍTULO III: HIPÓTESIS',
    productCodes: [],
  });
  assert.equal(esquema.capituloPropio(guardado, 'metodologia'), null);
  assert.equal(esquema.capituloPropio(guardado, 'propio-otro'), null);
});

test('el esquema se le cuenta al asistente con las fases de cada capítulo', () => {
  const texto = esquema.comoTexto(normalizar(UNSAAC), CATALOGO);

  assert.match(texto, /CAPÍTULO V: RESULTADOS Y DISCUSIÓN {2}← .*Resultados \+ .*Discusión/);
  assert.match(texto, /CAPÍTULO III: HIPÓTESIS {2}\(clave: propio-capitulo-iii-hipotesis\)/);
  assert.equal(esquema.comoTexto(null, CATALOGO), null);
});

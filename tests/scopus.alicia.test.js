'use strict';

/**
 * La búsqueda de Scopus llevada a ALICIA (CONCYTEC).
 *
 * Lo que tiene que ser cierto pase lo que pase:
 *
 *   · De la ecuación solo quedan las palabras y su estructura: los campos que
 *     no son texto (tipo, área, idioma, autor) se caen, y los años pasan a
 *     filtro.
 *   · Un «AND NOT x» que se queda solo no se convierte en un «x»: buscaría
 *     justo lo que el tesista quería excluir.
 *   · Cada término va en inglés O en español; si el modelo no contesta, se
 *     busca igual con lo que había.
 *   · La ficha guardada lleva el tipo de tesis exacto, que es de donde sale el
 *     «[Tesis de maestría, Universidad…]» de APA.
 *
 * El modelo y el repositorio se sustituyen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ruta = (m) => require.resolve(m);
const sustituir = (modulo, exports) => {
  const id = ruta(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const env = { asistenteEnabled: true, GEMINI_MODEL: 'modelo-a', GEMINI_MODEL_RESPALDO: 'modelo-b' };
sustituir('../src/config/env', env);
sustituir('../src/config/logger', { info: () => {}, warn: () => {}, error: () => {} });

const alicia = require('../src/modules/scopus/scopus.alicia');
const { comoFicha, esId } = require('../src/modules/references/alicia.client');

const DICCIONARIO = {
  'critical thinking': 'pensamiento crítico',
  'university students': 'estudiantes universitarios',
  secondary: 'secundaria',
  ChatGPT: 'ChatGPT',
};

const traductor = async ({ mensajes }) => {
  const { terminos } = JSON.parse(mensajes[0].texto);
  return { texto: JSON.stringify({ traducciones: terminos.map((t) => DICCIONARIO[t] ?? t) }) };
};

test('cada término se busca en inglés o en español, con la misma estructura', async () => {
  const { consulta } = await alicia.consultaParaAlicia(
    'TITLE-ABS-KEY("critical thinking") AND TITLE-ABS-KEY("university students")',
    { generar: traductor },
  );
  assert.equal(
    consulta,
    '(("critical thinking" OR "pensamiento crítico") AND ("university students" OR "estudiantes universitarios"))',
  );
});

test('los campos que no son texto se caen y los años pasan a filtro', async () => {
  const r = await alicia.consultaParaAlicia(
    '(TITLE-ABS-KEY(ChatGPT)) AND PUBYEAR > 2019 AND PUBYEAR < 2026 AND (DOCTYPE(ar) OR DOCTYPE(re)) AND SUBJAREA(SOCI)',
    { generar: traductor },
  );
  // ChatGPT se traduce igual: no se le añade un OR consigo mismo.
  assert.equal(r.consulta, 'ChatGPT');
  assert.equal(r.desde, 2020);
  assert.equal(r.hasta, 2025);
});

test('un AND NOT que se queda delante se quita, no se vuelve positivo', async () => {
  const { consulta } = await alicia.consultaParaAlicia('DOCTYPE(ar) AND NOT TITLE-ABS-KEY(secondary)', {
    generar: traductor,
  });
  assert.equal(consulta, '');
});

test('el AND NOT de en medio se conserva, con su traducción', async () => {
  const { consulta } = await alicia.consultaParaAlicia(
    'title-abs-key("critical thinking") AND NOT TITLE(secondary)',
    { generar: traductor },
  );
  assert.equal(
    consulta,
    '(("critical thinking" OR "pensamiento crítico") AND NOT (secondary OR "secundaria"))',
  );
});

test('una búsqueda solo por autor no tiene nada que llevar a ALICIA', async () => {
  const { consulta } = await alicia.consultaParaAlicia('AUTHOR-NAME(Kansal, P.)', { generar: traductor });
  assert.equal(consulta, '');
});

test('si el modelo falla se busca con los términos como estaban', async () => {
  const { consulta } = await alicia.consultaParaAlicia('TITLE-ABS-KEY(job AND satisfaction)', {
    generar: async () => {
      throw new Error('sin modelo');
    },
  });
  assert.equal(consulta, '(job AND satisfaction)');
});

test('la ficha de una tesis lleva la universidad como fuente y el tipo exacto', () => {
  const ficha = comoFicha({
    rawData: {
      id: 'UPAO_820c408978406207d0f35805795f9530',
      title: 'Pensamiento crítico y vocabulario inglés en estudiantes universitarios, 2020',
      author: ['Rodríguez Briceño, Roland Evert'],
      publishDate: ['2022'],
      format: ['masterThesis'],
      url: ['https://hdl.handle.net/20.500.12759/9919'],
      instname_str: 'Universidad Privada Antenor Orrego',
      'dc.contributor.advisor.fl_str_mv': ['Cabrera Vértiz, Luis Alberto'],
      topic: ['Pensamiento crítico', 'https://purl.org/pe-repo/ocde/ford#5.03.01'],
    },
    summary: ['El presente estudio…'],
  });

  assert.equal(ficha.tipo, 'Tesis de maestría');
  assert.equal(ficha.asesor, 'Cabrera Vértiz, Luis Alberto');

  const fila = alicia.comoFila(ficha);
  assert.equal(fila.sourceRef, 'alicia:UPAO_820c408978406207d0f35805795f9530');
  assert.equal(fila.itemType, 'masterThesis');
  assert.equal(fila.source, 'Universidad Privada Antenor Orrego');
  assert.equal(fila.year, 2022);
  assert.equal(fila.tags, 'Pensamiento crítico');
  assert.equal(fila.abstract, 'El presente estudio…');
});

test('la ficha de un artículo lleva la revista, no la universidad', () => {
  const ficha = comoFicha({
    rawData: {
      id: 'REVUNIFE_907e921e5779d6305ac977fe9db95d8e',
      title: 'Pensamiento crítico',
      format: ['article'],
      instname_str: 'Universidad Femenina del Sagrado Corazón',
      'dc.source.none.fl_str_mv': [
        'Educación; No. 13 (2007): Educación: Revista de la Facultad; 61-64',
        'reponame:Revistas - UNIFE',
      ],
    },
  });
  assert.equal(ficha.source, 'Educación');
  assert.equal(ficha.tipo, 'Artículo');
});

test('solo se aceptan identificadores con forma de ALICIA', () => {
  assert.ok(esId('UPAO_820c408978406207d0f35805795f9530'));
  assert.ok(!esId('UPAO_820c&id[]=otro'));
  assert.ok(!esId('../record'));
});

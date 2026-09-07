'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { aFila, esFuente, esNota, normalizar } = require('../src/modules/references/zotero.mapper');
const { gruposDeEtiquetas } = require('../src/modules/references/reference.repository');
const { cita } = require('../src/modules/references/reference.service');

/**
 * Lo que se prueba aquí es la credibilidad de una tesis.
 *
 * Todo este módulo existe por un motivo: que un DOI citado en el capítulo II
 * exista de verdad. Si el mapeo se come el año, confunde a un editor con el
 * autor o deja el DOI con el prefijo de la URL pegado, la cita sale mal
 * formada, y una cita mal formada la comprueba un jurado en diez segundos.
 *
 * Es también la única capa del corpus que se puede probar sin base de datos ni
 * red: aquí es donde un ítem de Zotero —treinta y pico tipos, cada uno con sus
 * campos— se convierte en las seis cosas que el conector sabe citar.
 */

function itemDeRevista(extra = {}) {
  return {
    version: 42,
    data: {
      key: 'ABCD1234',
      itemType: 'journalArticle',
      title: 'Validez de constructo en instrumentos de medición',
      creators: [
        { creatorType: 'author', firstName: 'Roberto', lastName: 'Hernández' },
        { creatorType: 'editor', firstName: 'Editor', lastName: 'Cualquiera' },
      ],
      date: '2018-05-10',
      publicationTitle: 'Revista de Psicología',
      DOI: 'https://doi.org/10.1000/xyz123',
      abstractNote: '<p>Un <b>resumen</b> con marcado.</p>',
      tags: [{ tag: 'tesis' }, { tag: 'metodologia' }],
      ...extra,
    },
  };
}

test('un editor no se cita como si fuera el autor', () => {
  const { fila } = aFila(itemDeRevista());
  assert.equal(fila.authors, 'Hernández, R.');
});

test('sin ningún autor se admite cualquier creador antes que dejar la fuente sin firma', () => {
  const { fila } = aFila(
    itemDeRevista({ creators: [{ creatorType: 'contributor', name: 'Ministerio de Educación' }] }),
  );
  assert.equal(fila.authors, 'Ministerio de Educación');
});

test('el DOI pierde el prefijo de la URL: pegarlo dos veces da un enlace roto', () => {
  const { fila } = aFila(itemDeRevista());
  assert.equal(fila.doi, '10.1000/xyz123');
});

test('un DOI escondido en «extra» también se recoge', () => {
  const { fila } = aFila(itemDeRevista({ DOI: undefined, extra: 'DOI: 10.5555/abc' }));
  assert.equal(fila.doi, '10.5555/abc');
});

test('el año sale de una fecha escrita como la dejó la revista', () => {
  assert.equal(aFila(itemDeRevista({ date: '2018-05-10' })).fila.year, 2018);
  assert.equal(aFila(itemDeRevista({ date: 'marzo de 2021' })).fila.year, 2021);
  assert.equal(aFila(itemDeRevista({ date: '' })).fila.year, null);
});

test('una fecha sin año no inventa uno', () => {
  const { fila } = aFila(itemDeRevista({ date: 'en prensa' }));
  assert.equal(fila.year, null);
  assert.match(cita(fila), /\(s\. f\.\)/);
});

test('el resumen se guarda sin marcado: el HTML de Zotero no se cita', () => {
  const { fila } = aFila(itemDeRevista());
  assert.equal(fila.abstract, 'Un resumen con marcado.');
});

test('la nota de Acosta viaja con la fuente', () => {
  const { fila } = aFila(itemDeRevista(), [
    { data: { note: '<p>Sirve para justificar el muestreo del cap. III</p>' } },
  ]);
  assert.equal(fila.notes, 'Sirve para justificar el muestreo del cap. III');
});

test('la columna de búsqueda va sin tildes: quien pregunta desde Claude no las escribe', () => {
  const { fila } = aFila(itemDeRevista());
  assert.match(fila.busqueda, /psicologia/);
  assert.match(fila.busqueda, /hernandez/);
  assert.equal(fila.busqueda, fila.busqueda.toLowerCase());
});

test('buscar «metodologia» encuentra «Metodología»', () => {
  assert.equal(normalizar('Metodología'), 'metodologia');
});

test('el tipo de fuente decide de dónde sale el «dónde se publicó»', () => {
  assert.equal(
    aFila(itemDeRevista({ itemType: 'book', publicationTitle: undefined, publisher: 'McGraw-Hill' }))
      .fila.source,
    'McGraw-Hill',
  );
  assert.equal(
    aFila(itemDeRevista({ itemType: 'thesis', publicationTitle: undefined, university: 'UNMSM' }))
      .fila.source,
    'UNMSM',
  );
});

test('las notas y los adjuntos no son fuentes', () => {
  assert.equal(esFuente(itemDeRevista()), true);
  assert.equal(esFuente({ data: { itemType: 'note' } }), false);
  assert.equal(esFuente({ data: { itemType: 'attachment' } }), false);
  assert.equal(esNota({ data: { itemType: 'note', parentItem: 'ABCD1234' } }), true);
  // Una nota suelta no cuelga de nada: no hay fuente a la que pegarla.
  assert.equal(esNota({ data: { itemType: 'note' } }), false);
});

test('la etiqueta de producto decide quién ve la fuente, y sin etiqueta la ve todo el mundo', () => {
  assert.deepEqual(gruposDeEtiquetas(['tesis']), ['METODO_9_SKILLS']);
  assert.deepEqual(gruposDeEtiquetas(['articulo']), ['ARTICULO_SCIENTIFICOS']);
  assert.deepEqual(gruposDeEtiquetas(['Tesis', 'ARTICULO']).sort(), [
    'ARTICULO_SCIENTIFICOS',
    'METODO_9_SKILLS',
  ]);
  // Es el caso normal, no el raro: la metodología sirve a las dos rutas.
  assert.deepEqual(gruposDeEtiquetas(['metodologia', 'apa']), []);
  assert.deepEqual(gruposDeEtiquetas([]), []);
});

test('la cita se arma de campos separados, no de memoria', () => {
  const { fila } = aFila(itemDeRevista());
  assert.equal(
    cita(fila),
    'Hernández, R. (2018). Validez de constructo en instrumentos de medición. ' +
      'Revista de Psicología. https://doi.org/10.1000/xyz123',
  );
});

test('sin DOI se cita la URL, y sin ninguna de las dos la cita termina en el punto', () => {
  const conUrl = aFila(itemDeRevista({ DOI: undefined, url: 'https://scielo.org.pe/x' })).fila;
  assert.match(cita(conUrl), /https:\/\/scielo\.org\.pe\/x$/);

  const sinNada = aFila(itemDeRevista({ DOI: undefined, url: undefined })).fila;
  assert.match(cita(sinNada), /Revista de Psicología\.$/);
});

/**
 * Lo repetido.
 *
 * La biblioteca se llenó exportando búsquedas de Scopus, y dos búsquedas que se
 * solapan traen artículos en común: el mismo trabajo entra otra vez con otra
 * clave de Zotero, y para la base son dos fuentes distintas. En una respuesta de
 * seis resultados, dos gastados en repetir el mismo artículo son dos que el
 * tesista no recibe. Lo notó el propio asistente en la primera prueba real.
 */

const { sinRepetidos } = require('../src/modules/references/reference.repository');

const fuente = (doi, title, year) => ({ doi, title, year });

test('el mismo DOI no ocupa dos huecos', () => {
  const filas = [
    fuente('10.1186/s12912-024-01848-6', 'The biosafety incident response scale', 2024),
    fuente('10.1186/s12912-024-01848-6', 'The biosafety incident response scale', 2024),
    fuente('10.2196/16520', 'eHealth acceptability scale', 2020),
  ];
  const unicas = sinRepetidos(filas, 6);
  assert.equal(unicas.length, 2);
  assert.equal(unicas[1].doi, '10.2196/16520');
});

test('se queda con la primera, que es la más relevante', () => {
  const filas = [
    fuente('10.1000/x', 'Construct validity', 2019),
    fuente('10.1000/X', 'Construct validity', 2024),
  ];
  const [primera] = sinRepetidos(filas, 6);
  // El DOI se compara sin distinguir mayúsculas: son el mismo artículo.
  assert.equal(sinRepetidos(filas, 6).length, 1);
  assert.equal(primera.year, 2019);
});

test('sin DOI se compara el título, que es lo único que queda', () => {
  const filas = [
    fuente(null, 'Metodología de la investigación', 2014),
    fuente(null, 'METODOLOGIA DE LA INVESTIGACION.', 2014),
    fuente(null, 'Otro trabajo distinto', 2014),
  ];
  assert.equal(sinRepetidos(filas, 6).length, 2);
});

test('dos artículos distintos sin DOI no se confunden', () => {
  const filas = [fuente(null, 'Validez de constructo', 2019), fuente(null, 'Validez de criterio', 2019)];
  assert.equal(sinRepetidos(filas, 6).length, 2);
});

test('devuelve como mucho las que se piden', () => {
  const filas = Array.from({ length: 20 }, (_, i) => fuente(`10.1000/${i}`, `Trabajo ${i}`, 2020));
  assert.equal(sinRepetidos(filas, 6).length, 6);
});

/**
 * El papeleo de Scopus.
 *
 * Casi todas las «notas» de esta biblioteca no las escribió nadie: son la ficha
 * que Scopus adjunta al exportar. Y el conector prefiere la nota al resumen, así
 * que sin filtrarlas le enseñaría al tesista «Export Date: 06 September 2026;
 * Conference code: 199657» en lugar de lo que trata el artículo — y firmado como
 * nota de Acosta, que es justo lo que la haría creíble.
 */

const { esPapeleoDeScopus } = require('../src/modules/references/zotero.mapper');

test('la ficha del exportador se reconoce y se tira', () => {
  for (const papeleo of [
    'Export Date: 06 September 2026; Cited By: 13; Conference name: ICCR 2024',
    'Cited By: 0; Funding details: Inyuvesi Yakwazulu-Natali, UKZN',
    'Correspondence Address: N.P. Nzimande; Department of Geography',
    'Conference code: 199657',
  ]) {
    assert.equal(esPapeleoDeScopus(papeleo), true, papeleo);
  }
});

test('una nota escrita por una persona se conserva', () => {
  for (const nota of [
    'Sirve para justificar el muestreo por conveniencia del capítulo III',
    'Ojo: esta revista está en la lista de depredadoras, no usar.',
    'El instrumento de este estudio es el que adapta Karina.',
    '',
  ]) {
    assert.equal(esPapeleoDeScopus(nota), false, nota);
  }
});

test('una nota de verdad que MENCIONA el papeleo no se tira: solo cuenta cómo empieza', () => {
  assert.equal(
    esPapeleoDeScopus('Muy citado (Cited By: 300), buen antecedente para el capítulo II'),
    false,
  );
});

test('Web of Science escribe su papeleo distinto, y también se tira', () => {
  assert.equal(esPapeleoDeScopus('Times Cited in Web of Science Core Collection:  1'), true);
  assert.equal(esPapeleoDeScopus('Total Times Cited:  18'), true);
  assert.equal(esPapeleoDeScopus('Cited Reference Count:  29'), true);
});

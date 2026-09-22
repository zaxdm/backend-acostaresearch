'use strict';

/**
 * Las citas de Zotero, los hipervínculos y el índice.
 *
 * Esto es lo que rompió la primera prueba real del servicio: de 23 párrafos, 8
 * volvieron en español. Cinco eran las líneas del índice —que no había que
 * traducir y se estaban mandando al modelo igualmente— y tres eran los párrafos
 * buenos del planteamiento, que llevaban citas de Zotero y por eso el motor se
 * negaba a tocarlos.
 *
 * Lo que se fija aquí:
 *   · Un párrafo con cita SE traduce, y la cita sigue siendo un campo de Word,
 *     con su JSON, para que Zotero pueda renumerar y rehacer la bibliografía.
 *   · Si la cita no vuelve tal cual del modelo, el párrafo se queda como estaba.
 *     Una cita movida de sitio es peor que un párrafo sin traducir.
 *   · Las líneas del índice no se le mandan al modelo ni se le cobran al
 *     cliente, aunque el Word no declare el estilo (el nuestro no lo declara).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const documento = require('../src/modules/projects/project.documento');
const cuerpo = require('../src/modules/preparar/preparar.cuerpo');
const campos = require('../src/modules/preparar/preparar.campos');
const motor = require('../src/modules/preparar/preparar.motor');
const traduccion = require('../src/modules/preparar/preparar.traduccion');
const cambios = require('../src/modules/preparar/preparar.cambios');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const t = (texto) => `<w:r><w:t xml:space="preserve">${texto}</w:t></w:r>`;

/** Una cita de Zotero tal y como la escribe el plugin: campo, JSON y texto visible. */
const cita = (visible, id = 'c1') =>
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
  `<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"${id}"} </w:instrText></w:r>` +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
  `<w:r><w:rPr><w:i w:val="false"/></w:rPr><w:t xml:space="preserve">${visible}</w:t></w:r>` +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r>';

/** Una línea del índice como la escribe nuestro generador: estilo TOC2 sin declarar. */
const LINEA_DE_INDICE =
  '<w:p><w:pPr><w:pStyle w:val="TOC2"/></w:pPr>' +
  '<w:hyperlink w:anchor="_TocAR0002" w:history="1">' +
  t('Planteamiento del problema') +
  '<w:r><w:tab/></w:r>' +
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
  '<w:r><w:instrText xml:space="preserve"> PAGEREF _TocAR0002 </w:instrText></w:r>' +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
  t('3') +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
  '</w:hyperlink></w:p>';

const PARRAFO_CON_CITA =
  '<w:p>' +
  t('El acceso a la tecnología dejó de ser el problema principal ') +
  cita('(Ong et al., 2022)') +
  t(' en la mayoría de los hogares.') +
  '</w:p>';

function docx(cuerpoXml) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${cuerpoXml}</w:body></w:document>`,
    ),
  );
  // Sin estilos declarados: es el caso del Word que genera este mismo sistema.
  zip.addFile('word/styles.xml', Buffer.from(`<?xml version="1.0"?><w:styles xmlns:w="${W}"/>`));
  return zip.toBuffer();
}

const parte = (buffer) => new AdmZip(buffer).getEntry('word/document.xml').getData().toString('utf8');
const veces = (texto, aguja) => texto.split(aguja).length - 1;

/** Un modelo que aplica `transformar` a cada párrafo. */
const modeloQue = (transformar) => async ({ mensajes }) => {
  const entrada = JSON.parse(mensajes[0].texto);
  return {
    texto: JSON.stringify(
      Object.fromEntries(Object.entries(entrada).map(([id, texto]) => [id, transformar(texto)])),
    ),
  };
};

const traducirCon = async (buffer, transformar) => {
  const { parrafos } = cuerpo.cuerpoDe(buffer);
  const { cambios: propuestos } = await motor.prepararParrafos({
    parrafos,
    servicio: 'TRADUCCION',
    idioma: 'en',
    generar: modeloQue(transformar),
    porTanda: 1000,
  });
  return traduccion.traducir(buffer, propuestos);
};

// ── Apartar y devolver ─────────────────────────────────────────────────────

test('proteger deja una marca donde estaba la cita y se la lleva entera', () => {
  const { xml, campos: apartados } = campos.proteger(PARRAFO_CON_CITA);

  assert.equal(apartados.length, 1);
  assert.equal(apartados[0].texto, '(Ong et al., 2022)');
  assert.match(apartados[0].xml, /ZOTERO_ITEM/);
  // En el párrafo ya no queda campo: es texto corriente y el motor puede con él.
  assert.ok(!xml.includes('fldChar'));
  assert.ok(!xml.includes('(Ong et al., 2022)'));
  assert.ok(xml.includes(apartados[0].marca));
});

test('la marca vuelve a ser el campo, y el texto de alrededor no se pierde', () => {
  const { campos: apartados } = campos.proteger(PARRAFO_CON_CITA);
  const marca = apartados[0].marca;
  const hecho = campos.restaurar(
    `<w:p><w:r><w:t xml:space="preserve">Según ${marca} el acceso mejoró.</w:t></w:r></w:p>`,
    apartados,
  );

  assert.match(hecho, /ZOTERO_ITEM/);
  assert.match(hecho, /Según /);
  assert.match(hecho, /el acceso mejoró\./);
  assert.ok(!campos.llevaMarcas(hecho), 'no queda ninguna marca suelta');
});

test('si la cita no vuelve tal cual del modelo, no se adivina dónde va', () => {
  const { campos: apartados } = campos.proteger(PARRAFO_CON_CITA);

  assert.throws(
    () => campos.enmascarar('The access improved (Ong and others, 2022) in most homes.', apartados),
    campos.NoProtegible,
  );
});

/**
 * El caso que apareció en la primera tesis de verdad: citas narrativas, donde
 * Zotero deja en el campo solo el año. «(2024)» aparece tantas veces como citas
 * de ese año tenga el párrafo, así que no se puede exigir que sea única.
 */
test('dos citas iguales se colocan en su orden, no se rechaza el párrafo', () => {
  const { campos: apartados } = campos.proteger(
    `<w:p>${t('La UIT ')}${cita('(2024)')}${t(' y el INEI ')}${cita('(2024)', 'c2')}${t(' coinciden.')}</w:p>`,
  );

  assert.equal(apartados.length, 2);

  const puesto = campos.enmascarar('The ITU (2024) and INEI (2024) agree.', apartados);
  const primera = puesto.indexOf(apartados[0].marca);
  const segunda = puesto.indexOf(apartados[1].marca);

  assert.ok(primera > -1 && segunda > -1, 'las dos se colocan');
  assert.ok(primera < segunda, 'y en el mismo orden que en el original');
  assert.ok(!puesto.includes('(2024)'), 'ninguna se queda sin marcar');
});

test('una cita que el modelo se comió deja el párrafo como estaba', () => {
  const { campos: apartados } = campos.proteger(
    `<w:p>${t('La UIT ')}${cita('(2024)')}${t(' y el INEI ')}${cita('(2024)', 'c2')}${t(' coinciden.')}</w:p>`,
  );

  assert.throws(() => campos.enmascarar('The ITU (2024) and INEI agree.', apartados), campos.NoProtegible);
});

// ── Traducir con citas ─────────────────────────────────────────────────────

test('un párrafo con cita de Zotero SÍ se traduce, y la cita sigue siendo un campo', async () => {
  const buffer = docx(PARRAFO_CON_CITA);
  const hecho = await traducirCon(buffer, (texto) => texto.replace('El acceso', '[EN] Access'));
  const xml = parte(hecho.buffer);

  assert.equal(hecho.tocados, 1);
  assert.equal(hecho.intactos.size, 0);
  assert.match(xml, /\[EN\] Access/);
  // La cita, entera y una sola vez: ni duplicada como texto ni perdida.
  assert.equal(veces(xml, 'ZOTERO_ITEM'), 1);
  assert.equal(veces(xml, '(Ong et al., 2022)'), 1);
  assert.equal(veces(xml, 'w:fldCharType="begin"'), 1);
  assert.equal(veces(xml, 'w:fldCharType="end"'), 1);
  assert.ok(!campos.llevaMarcas(xml));
});

test('el párrafo traducido se puede volver a leer, con la cita en su sitio', async () => {
  const buffer = docx(PARRAFO_CON_CITA);
  const hecho = await traducirCon(buffer, (texto) => texto.replace('El acceso', '[EN] Access'));

  const leido = documento.leer(hecho.buffer);
  assert.equal(leido.length, 1);
  assert.match(leido[0].texto, /\[EN\] Access.*\(Ong et al\., 2022\).*hogares/s);
});

test('si el modelo toca la cita, el párrafo se queda como estaba', async () => {
  const buffer = docx(PARRAFO_CON_CITA);
  const hecho = await traducirCon(buffer, (texto) => texto.replace('(Ong et al., 2022)', '(Ong y otros, 2022)'));
  const xml = parte(hecho.buffer);

  assert.equal(hecho.tocados, 0);
  assert.equal(hecho.intactos.size, 1);
  assert.match(xml, /El acceso a la tecnología dejó de ser el problema principal/);
  assert.equal(veces(xml, 'ZOTERO_ITEM'), 1);
});

test('una imagen dentro del párrafo sigue dejándolo intacto', async () => {
  const conImagen =
    '<w:p>' + t('Este párrafo lleva una figura pegada ') +
    '<w:r><w:drawing><wp:inline/></w:drawing></w:r>' + t(' y sigue.') + '</w:p>';

  const hecho = await traducirCon(docx(conImagen), (texto) => `[EN] ${texto}`);

  assert.equal(hecho.tocados, 0);
  assert.equal(hecho.intactos.size, 1);
  assert.match(hecho.intactos.get(1), /imagen/);
});

// ── Corregir con citas ─────────────────────────────────────────────────────

test('la edición marca la corrección y deja la cita viva', async () => {
  const buffer = docx(
    `<w:p>${t('The access shows a clear improvement ')}${cita('(Ong et al., 2022)')}${t(' in most homes.')}</w:p>`,
  );
  const { parrafos } = cuerpo.cuerpoDe(buffer);

  const { cambios: propuestos } = await motor.prepararParrafos({
    parrafos,
    servicio: 'EDICION',
    generar: modeloQue((texto) => texto.replace('shows', 'showed')),
    porTanda: 1000,
  });

  const hecho = cambios.aplicar(buffer, propuestos, { fecha: new Date('2026-09-22T10:00:00Z') });
  const xml = parte(hecho.buffer);

  assert.equal(hecho.tocados, 1, 'antes este párrafo se quedaba sin corregir por llevar la cita');
  assert.match(xml, /<w:delText xml:space="preserve">shows <\/w:delText>/);
  assert.match(xml, /<w:ins [^>]*>[\s\S]*?showed /);
  assert.equal(veces(xml, 'ZOTERO_ITEM'), 1);
  assert.equal(veces(xml, '(Ong et al., 2022)'), 1);
  assert.ok(!campos.llevaMarcas(xml));
});

test('si la corrección se lleva la cita por delante, el párrafo se queda como estaba', async () => {
  const buffer = docx(`<w:p>${t('The access improved ')}${cita('(Ong et al., 2022)')}${t(' clearly.')}</w:p>`);
  const { parrafos } = cuerpo.cuerpoDe(buffer);

  const hecho = cambios.aplicar(buffer, {
    [parrafos[0].id]: { original: parrafos[0].texto, texto: 'The access improved clearly.' },
  });

  assert.equal(hecho.tocados, 0);
  assert.equal(hecho.intactos.size, 1);
  assert.equal(veces(parte(hecho.buffer), 'ZOTERO_ITEM'), 1);
});

// ── El índice ──────────────────────────────────────────────────────────────

test('el índice no se le manda al modelo aunque el Word no declare el estilo', () => {
  const buffer = docx(LINEA_DE_INDICE + `<w:p>${t('El acceso a la tecnología cambió.')}</w:p>`);
  const { parrafos, palabras } = cuerpo.cuerpoDe(buffer);

  assert.deepEqual(
    parrafos.map((parrafo) => parrafo.texto),
    ['El acceso a la tecnología cambió.'],
  );
  assert.equal(palabras, 6, 'ni se traducen ni se le cuentan al cliente');
});

test('el índice se queda tal cual en el documento entregado', async () => {
  const buffer = docx(LINEA_DE_INDICE + `<w:p>${t('El acceso a la tecnología cambió.')}</w:p>`);
  const hecho = await traducirCon(buffer, (texto) => `[EN] ${texto}`);
  const xml = parte(hecho.buffer);

  assert.equal(hecho.tocados, 1);
  assert.match(xml, /PAGEREF _TocAR0002/);
  assert.match(xml, />Planteamiento del problema</);
  assert.match(xml, /\[EN\] El acceso a la tecnología cambió\./);
});

'use strict';

/**
 * Las citas, en el idioma de la traducción (24-sep-2026).
 *
 * Solo cambian las palabras del estilo —el conector entre autores, «n.d.»,
 * «in press»…—; apellidos, años y «et al.» nunca. Y una cita de Zotero sigue
 * siendo un campo de Zotero después de traducida.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const { localizar } = require('../src/modules/preparar/preparar.citas');
const campos = require('../src/modules/preparar/preparar.campos');
const cuerpo = require('../src/modules/preparar/preparar.cuerpo');
const motor = require('../src/modules/preparar/preparar.motor');
const traduccion = require('../src/modules/preparar/preparar.traduccion');

test('al español: «&» pasa a «y», «n.d.» a «s.f.»; apellidos, años y et al. igual', () => {
  assert.equal(
    localizar('(Ballesteros & Acosta Enriquez, 2024; Zhang et al., 2024)', 'es'),
    '(Ballesteros y Acosta Enriquez, 2024; Zhang et al., 2024)',
  );
  assert.equal(localizar('(Ong, n.d.; see Pérez & Gil, in press)', 'es'), '(Ong, s.f.; véase Pérez y Gil, en prensa)');
  assert.equal(localizar('(e.g., Ong et al., 2022)', 'es'), '(p. ej., Ong et al., 2022)');
});

test('al inglés: «&» entre paréntesis y «and» en la narrativa, como pide APA', () => {
  assert.equal(localizar('(Pérez y Gil, s.f.)', 'en'), '(Pérez & Gil, n.d.)');
  assert.equal(localizar('Pérez y Gil (2020)', 'en'), 'Pérez and Gil (2020)');
});

test('al portugués «e» y «s.d.»; al chino no se toca', () => {
  assert.equal(localizar('(Xiong & Zhang, n.d.)', 'pt'), '(Xiong e Zhang, s.d.)');
  assert.equal(localizar('(Xiong & Zhang, 2025)', 'zh'), '(Xiong & Zhang, 2025)');
});

test('el conector que cambió de idioma no hace perder la cita; otro año sí', () => {
  assert.equal(campos.citaQueFalta('Según (Xiong y Zhang, 2025).', ['(Xiong & Zhang, 2025)']), null);
  assert.equal(campos.citaQueFalta('Según (Ong, s.f.).', ['(Ong, n.d.)']), null);
  assert.equal(campos.citaQueFalta('Según (Xiong y Zhang, 2024).', ['(Xiong & Zhang, 2025)']), '(Xiong & Zhang, 2025)');
});

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const t = (texto) => `<w:r><w:t xml:space="preserve">${texto}</w:t></w:r>`;
const cita = (visible) =>
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
  '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"c1","locator":"&amp;"} </w:instrText></w:r>' +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
  `<w:r><w:t xml:space="preserve">${visible}</w:t></w:r>` +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r>';

function docx(cuerpoXml) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${cuerpoXml}</w:body></w:document>`),
  );
  zip.addFile('word/styles.xml', Buffer.from(`<?xml version="1.0"?><w:styles xmlns:w="${W}"/>`));
  return zip.toBuffer();
}

test('traducida, la cita de Zotero dice «y» y sigue siendo un campo con su JSON intacto', async () => {
  const buffer = docx(`<w:p>${t('Intention to use AI ')}${cita('(Xiong &amp; Zhang, 2025)')}${t(' is growing.')}</w:p>`);
  const { parrafos } = cuerpo.cuerpoDe(buffer, { todo: true });

  const { cambios } = await motor.prepararParrafos({
    parrafos,
    servicio: 'TRADUCCION',
    idioma: 'es',
    // Como Gemini: traduce y cambia el conector de la cita.
    generar: async () => ({ texto: JSON.stringify({ 1: 'La intención de usar la IA (Xiong y Zhang, 2025) va en aumento.' }) }),
    porTanda: 1000,
  });
  const hecho = traduccion.traducir(buffer, cambios, parrafos, { idioma: 'es' });
  const xml = new AdmZip(hecho.buffer).getEntry('word/document.xml').getData().toString('utf8');

  assert.equal(hecho.tocados, 1);
  assert.match(xml, />\(Xiong y Zhang, 2025\)</, 'lo que se ve, en español');
  assert.match(xml, /"locator":"&amp;"/, 'el JSON de Zotero, tal cual');
  assert.match(xml, /ZOTERO_ITEM/);
  assert.doesNotMatch(xml, /Xiong &amp; Zhang/);
});

test('«Nota:» al principio es la nota de una tabla, no una excusa del modelo', () => {
  const original = 'Note: Pedagogical paradigm (PP); Hedonic motivation (HM); Habit (HT).';
  assert.equal(motor.comprobar(original, 'Nota: Paradigma pedagógico (PP); Motivación hedónica (HM); Hábito (HT).', { servicio: 'TRADUCCION', idioma: 'es' }), null);
  assert.match(motor.comprobar(original, '[Nota: no traduzco esto] Note: Pedagogical paradigm (PP).', { servicio: 'TRADUCCION', idioma: 'es' }), /excusa/);
});

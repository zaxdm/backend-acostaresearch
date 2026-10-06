'use strict';

/**
 * El formato tomado del avance que sube el tesista.
 *
 * Quien ya escribe sobre la plantilla de su universidad sube ese Word como
 * avance, y su tesis tiene que salir con ese formato, no con el de por defecto
 * (6-oct-2026). Pero un Word recién abierto no trae formato de nadie y no se
 * copia, y nunca se pisa una plantilla de la universidad.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const plantilla = require('../src/modules/projects/project.plantilla');
const projectRepository = require('../src/modules/projects/project.repository');
const projectService = require('../src/modules/projects/project.service');

const LARGO = 'Este es un párrafo del cuerpo de la tesis con suficiente texto para contar como cuerpo. '.repeat(4);

/** Un .docx mínimo: cinco párrafos largos con el formato dado, y la hoja con sus valores por defecto. */
function word({ fuente, medios, linea, regla = 'auto', defectos = '' }) {
  const rPr = `<w:rPr>${fuente ? `<w:rFonts w:ascii="${fuente}" w:hAnsi="${fuente}"/>` : ''}${medios ? `<w:sz w:val="${medios}"/>` : ''}</w:rPr>`;
  const pPr = linea ? `<w:pPr><w:spacing w:line="${linea}" w:lineRule="${regla}"/></w:pPr>` : '';
  const parrafo = `<w:p>${pPr}<w:r>${rPr}<w:t>${LARGO}</w:t></w:r></w:p>`;
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(`<w:document xmlns:w="w"><w:body>${parrafo.repeat(6)}<w:sectPr/></w:body></w:document>`),
  );
  zip.addFile('word/styles.xml', Buffer.from(`<w:styles xmlns:w="w"><w:docDefaults>${defectos}</w:docDefaults></w:styles>`));
  return zip.toBuffer();
}

test('Times 12 a 1,5: es el formato de su universidad', () => {
  const r = plantilla.formatoPropio(word({ fuente: 'Times New Roman', medios: 24, linea: 360 }));
  assert.equal(r.propio, true);
  assert.deepEqual(r.cuerpo, { fuente: 'Times New Roman', puntos: 12, interlineado: 1.5 });
});

test('Arial 12 a espacio sencillo también: la letra ya dice que lo formateó', () => {
  assert.equal(plantilla.formatoPropio(word({ fuente: 'Arial', medios: 24, linea: 240 })).propio, true);
});

test('Calibri 11 a 1,08, el Word recién abierto, no se toma', () => {
  assert.equal(plantilla.formatoPropio(word({ fuente: 'Calibri', medios: 22, linea: 259 })).propio, false);
});

test('sin letra escrita es la del tema (la de fábrica), aunque vaya a 12', () => {
  const defectos = '<w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi"/><w:sz w:val="24"/></w:rPr></w:rPrDefault>';
  assert.equal(plantilla.formatoPropio(word({ linea: 276, defectos })).propio, false);
});

test('el interlineado puede venir de los valores por defecto del documento', () => {
  const defectos = '<w:pPrDefault><w:pPr><w:spacing w:line="480" w:lineRule="auto"/></w:pPr></w:pPrDefault>';
  const r = plantilla.formatoPropio(word({ fuente: 'Calibri', medios: 22, defectos }));
  assert.equal(r.propio, true);
  assert.equal(r.cuerpo.interlineado, 2);
});

test('un archivo que no es un Word no se toma, y no lanza', () => {
  assert.deepEqual(plantilla.formatoPropio(Buffer.from('%PDF-1.7')), { propio: false, cuerpo: null });
});

test('una plantilla de la universidad ya subida no se pisa con la de su avance', async (t) => {
  t.mock.method(projectRepository, 'buscar', async () => ({
    id: 'p1',
    plantillaAt: new Date(),
    plantillaNombre: 'Formato UNT 2026.docx',
  }));
  const guardar = t.mock.method(projectRepository, 'productosConLicencia', async () => ['METODO_9_SKILLS']);

  const r = await projectService.formatoDesdeSuWord({
    userId: 'u1',
    productCode: 'METODO_9_SKILLS',
    buffer: word({ fuente: 'Times New Roman', medios: 24, linea: 360 }),
    nombre: 'avance.docx',
  });
  assert.deepEqual(r, { tomado: false, porque: 'ya-tiene', nombre: 'Formato UNT 2026.docx' });
  assert.equal(guardar.mock.callCount(), 0, 'ni se llega a guardar');
});

test('un Word sin formato deja el formato por defecto y se le dice por qué', async (t) => {
  t.mock.method(projectRepository, 'buscar', async () => ({ id: 'p1', plantillaAt: null }));
  const r = await projectService.formatoDesdeSuWord({
    userId: 'u1',
    productCode: 'METODO_9_SKILLS',
    buffer: word({ fuente: 'Calibri', medios: 22, linea: 259 }),
    nombre: 'avance.docx',
  });
  assert.equal(r.tomado, false);
  assert.equal(r.porque, 'sin-formato');
  assert.match(projectService.mensajeDeFormatoDeSuWord(r), /sigue con el formato por defecto/);
});

test('el formato de un avance anterior sí se cambia por el del nuevo', () => {
  assert.equal(projectService.esFormatoDeSuWord('De su avance «avance-v2.docx»'), true);
  assert.equal(projectService.esFormatoDeSuWord('Formato según sus indicaciones'), false);
  assert.equal(projectService.esFormatoDeSuWord('Formato UNT.docx'), false);
});

test('el mensaje dice con qué formato va a salir', () => {
  const m = projectService.mensajeDeFormatoDeSuWord({
    tomado: true,
    cuerpo: { fuente: 'Times New Roman', puntos: 12, interlineado: 1.5 },
  });
  assert.match(m, /Times New Roman 12, interlineado 1,5/);
  assert.match(m, /no con el formato por defecto/);
});

'use strict';

const AdmZip = require('adm-zip');
const normas = require('../../src/modules/projects/project.normas');

// Los mismos artículos de word.norma.test.js / word.mendeley.test.js.
const FUENTES = [
  {
    ref: 'AR11111111', itemType: 'journalArticle',
    title: 'Disentangling behavioral intention and behavioral expectation',
    authors: 'Warshaw, P. R.; Davis, F. D.', year: 1985,
    source: 'Journal of Experimental Social Psychology', volume: '21', issue: '3', pages: '213-228',
    sourceRef: 'mendeley:perfil-1:doc-abc',
  },
  {
    ref: 'AR22222222', itemType: 'journalArticle', title: 'Using thematic analysis in psychology',
    authors: 'Braun, V.; Clarke, V.', year: 2006,
    source: 'Qualitative Research in Psychology', volume: '3', issue: '2', pages: '77-101',
  },
];

function proyecto(norma = 'apa', extras = {}) {
  return {
    estiloCitas: norma,
    idiomaCitas: 'es-ES',
    recursos: normas.recursosDe(norma),
    capitulos: [{ titulo: 'Capítulo I', texto: 'Uno [AR11111111].\n\n[AR22222222:n] proponen seis fases.\n\nDato [FALTA FUENTE].' }],
    fuentes: FUENTES,
    opciones: { tema: 'Un tema', carrera: 'Una carrera', universidad: 'Una universidad', nombre: 'Alguien' },
    ...extras,
  };
}

function docx(parrafos) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  const cuerpo = parrafos.map((texto) => `<w:p><w:r><w:t>${texto}</w:t></w:r></w:p>`).join('');
  zip.addFile('word/document.xml', Buffer.from(
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${cuerpo}<w:sectPr/></w:body></w:document>`,
  ));
  return zip.toBuffer();
}

// El patrón de citas.tesis-grande.test.js: 400 citas y 60 fuentes distintas.
function proyectoGrande() {
  const clave = (n) => `AR${n.toString(16).toUpperCase().padStart(8, '0')}`;
  const apellidos = ['Pérez', 'García', 'Quispe', 'Torres', 'Rojas', 'Flores', 'Mendoza', 'Vargas', 'Castillo', 'Huamán'];
  const fuentes = Array.from({ length: 60 }, (_, i) => ({
    ref: clave(i + 1), itemType: 'journalArticle', title: `Estudio número ${i + 1} sobre gestión educativa`,
    authors: `${apellidos[i % 10]}, J.; ${apellidos[(i + 3) % 10]}, M.`,
    year: 2015 + (i % 9), source: 'Revista Peruana de Educación', volume: String(i + 1), pages: `${i + 1}-${i + 20}`,
  }));
  const parrafos = Array.from({ length: 400 }, (_, i) => {
    const a = fuentes[(i * 7) % fuentes.length].ref;
    const b = fuentes[(i * 11 + 3) % fuentes.length].ref;
    if (i % 5 === 0) return `Según lo revisado [${a}:n] la gestión mejora.`;
    if (i % 5 === 1) return `Los datos lo confirman [${a}][${b}].`;
    if (i % 5 === 2) return `Se cita textualmente [${a}:p. ${i}].`;
    return `La evidencia es amplia [${a}].`;
  });
  return proyecto('apa', { fuentes, capitulos: [{ titulo: 'Capítulo I', texto: parrafos.join('\n\n') }] });
}

module.exports = { FUENTES, proyecto, proyectoGrande, docx };

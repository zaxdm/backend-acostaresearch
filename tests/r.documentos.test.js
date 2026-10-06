'use strict';

/**
 * La matriz armada desde muchos informes en PDF.
 *
 * El caso que lo pidió: 80 informes de laboratorio de caballos, el hemograma y
 * la bioquímica de cada uno, con nombres de archivo que no coinciden del todo
 * («CAB 01.pdf» y «CAB01.pdf»). Las filas de celdas de abajo son las que salen
 * de verdad de esos PDF (VetScan HM5 y la bioquímica de la clínica); los PDF de
 * las pruebas de punta a punta se generan aquí con pdfkit.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const PDFDocument = require('pdfkit');

const documentos = require('../src/modules/r/r.documentos');
const { ArchivoNoValido } = require('../src/modules/r/r.formato');

// ── Las filas de resultados ─────────────────────────────────────────────────

test('una fila del hemograma: nombre, valor, unidad y rango', () => {
  assert.deepEqual(documentos.resultadosDe(['LEU', '7.43', '10⁹/l', '5.40', '14.30']), [
    { etiqueta: 'LEU', valor: 7.43, fueraDeMedicion: false, unidad: '10⁹/l' },
  ]);
});

test('la marca de fuera de rango («+» o «-») no se come el valor', () => {
  const [chcm] = documentos.resultadosDe(['CHCM', '39.8', '+', 'g/dl', '31.0', '39.0']);
  assert.equal(chcm.valor, 39.8);
  assert.equal(chcm.unidad, 'g/dl');
  const [plt] = documentos.resultadosDe(['PLT', '65', '10⁹/l', '-', '100', '400']);
  assert.equal(plt.valor, 65);
});

test('la bioquímica, con el rango «2.1-4.3» y las barras del gráfico', () => {
  const [alb] = documentos.resultadosDe(['ALB', '3.2', 'g/dL', '2.1-4.3', 'Ű Ű Ű Ű Ű', 'Ű Ű Ű Ű Ű']);
  assert.deepEqual(alb, { etiqueta: 'ALB', valor: 3.2, fueraDeMedicion: false, unidad: 'g/dL' });
});

test('dos analitos en la misma fila, y la coma decimal', () => {
  const r = documentos.resultadosDe(['Glucosa', '85,5', 'mg/dL', 'Urea', '30', 'mg/dL']);
  assert.deepEqual(
    r.map((x) => [x.etiqueta, x.valor]),
    [
      ['Glucosa', 85.5],
      ['Urea', 30],
    ],
  );
});

test('«LEU 7.43» en una celda y «0.60 ml» en otra', () => {
  assert.equal(documentos.resultadosDe(['LEU 7.43', '10⁹/l'])[0].valor, 7.43);
  const [lisante] = documentos.resultadosDe(['Lisante de LEU', '0.60 ml']);
  assert.deepEqual([lisante.etiqueta, lisante.valor, lisante.unidad], ['Lisante de LEU', 0.6, 'ml']);
  // El número es parte del nombre cuando lo que sigue ya es el valor.
  assert.equal(documentos.resultadosDe(['Lisis 2', '3.50 ml'])[0].etiqueta, 'Lisis 2');
});

test('«<0.5» queda vacío y se cuenta, no se inventa un valor', () => {
  const [r] = documentos.resultadosDe(['PCR', '<0.5', 'mg/L']);
  assert.equal(r.valor, null);
  assert.equal(r.fueraDeMedicion, true);
});

test('los ejes de los gráficos y las filas de cabecera no son resultados', () => {
  assert.deepEqual(documentos.resultadosDe(['35', '87', '87', '400 fl']), []);
  assert.deepEqual(documentos.resultadosDe(['análisis', '1', ':', '2025-03-23']), []);
  assert.deepEqual(documentos.resultadosDe(['LIP:0 (67)', 'HEM :0 (1)']), []);
  assert.deepEqual(documentos.resultadosDe(['#A/G', '#B/C', '#GLOB']), []);
});

// ── La cabecera ─────────────────────────────────────────────────────────────

const campos = (celdas) => Object.fromEntries(documentos.camposDe(celdas).map((c) => [c.clave === 'quitar' ? c.etiqueta : c.clave, c.valor]));

test('la cabecera del VetScan, sin «:» y con la etiqueta pegada al valor anterior', () => {
  assert.deepEqual(campos(['ID del paciente', 'CHAPARRA Edad', '3 a']), { paciente: 'CHAPARRA', edad: '3 a' });
  assert.deepEqual(campos(['Especie', 'Caballo Sexo', 'Hembra']), { especie: 'Caballo', sexo: 'Hembra' });
  const fecha = documentos.camposDe(['Fecha de la prueba', '23/03/2025 10:36', 'N.º de serie', '360016501']);
  assert.equal(fecha[0].clave, 'fecha');
  assert.equal(fecha[0].valor, '23/03/2025 10:36', 'el «:» de la hora no parte el valor');
  assert.equal(fecha[1].clave, 'quitar');
});

test('la cabecera de la bioquímica: una etiqueta desconocida con «:» corta el valor', () => {
  assert.deepEqual(campos(['Raza', ':', 'CPP', 'Toma medicinas', ':']), { raza: 'CPP' });
  assert.deepEqual(campos(['Nombre médico', ': ', 'Lander Lacuta', 'Dueño', ': CARLOS SONANI']), {
    'Nombre médico': 'Lander Lacuta',
    Dueño: 'CARLOS SONANI',
  });
  assert.equal(documentos.camposDe(['Dueño', ': CARLOS SONANI'])[0].clave, 'quitar');
});

test('edad y fecha se normalizan', () => {
  assert.equal(documentos.edadEnAnios('3 a'), 3);
  assert.equal(documentos.edadEnAnios('18 meses'), 1.5);
  assert.equal(documentos.edadEnAnios('2 años 6 meses'), 2.5);
  assert.equal(documentos.fechaIso('23/03/2025 10:36'), '2025-03-23');
  assert.equal(documentos.fechaIso('2025-03-23'), '2025-03-23');
  assert.equal(documentos.fechaIso('Desconocido'), null);
});

// ── Qué archivos son del mismo caso ─────────────────────────────────────────

const agrupar = (rutas) => {
  const r = documentos.agrupar(rutas.map((ruta) => ({ ruta })));
  return { por: r.por, grupos: r.grupos.map((g) => `${g.id}:${g.informes.length}`) };
};

test('«CAB 01.pdf» y «CAB01.pdf» son el mismo caso', () => {
  assert.deepEqual(agrupar(['data/CAB 01.pdf', 'data/CAB01.pdf', 'data/CAB 02.pdf', 'data/CAB02.pdf']), {
    por: 'nombre',
    grupos: ['CAB 01:2', 'CAB 02:2'],
  });
  assert.equal(documentos.claveDeNombre('hemograma CAB1.pdf'), documentos.claveDeNombre('Bioquímica - CAB01.pdf'));
});

test('una carpeta por caso', () => {
  assert.deepEqual(agrupar(['x/CAB01/h.pdf', 'x/CAB01/b.pdf', 'x/CAB02/h.pdf', 'x/CAB02/b.pdf']), {
    por: 'carpeta',
    grupos: ['CAB01:2', 'CAB02:2'],
  });
});

test('si el nombre no junta nada, se junta por el código que lleva', () => {
  assert.deepEqual(
    agrupar(['P-003 Perfil lipídico.pdf', 'P-003 Perfil hepático.pdf', 'P-004 Perfil lipídico.pdf']),
    { por: 'codigo', grupos: ['P-003:2', 'P-004:1'] },
  );
});

test('los nombres de columna se pueden usar en R sin comillas', () => {
  const usados = new Set();
  assert.deepEqual(
    ['LYM%', '#A/G', 'Glucosa (ayunas)', 'Hb', '1,25-OH', 'Hb', 'id'].map((e) => documentos.nombreDeColumna(e, usados)),
    ['LYM_pct', 'A_G', 'Glucosa_ayunas', 'Hb', 'x1_25_OH', 'Hb_2', 'id_2'],
  );
});

// ── De punta a punta, con PDF de verdad ─────────────────────────────────────

/** Un informe de laboratorio como los que imprime un equipo: cabecera y filas «nombre · valor · unidad». */
function informe({ cabecera, filas }) {
  return new Promise((resolver) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const partes = [];
    doc.on('data', (p) => partes.push(p));
    doc.on('end', () => resolver(Buffer.concat(partes)));
    doc.fontSize(10);
    let y = 60;
    for (const [etiqueta, valor] of cabecera) {
      doc.text(etiqueta, 50, y, { lineBreak: false });
      doc.text(`: ${valor}`, 160, y, { lineBreak: false });
      y += 16;
    }
    y += 20;
    for (const [etiqueta, valor, unidad, rango] of filas) {
      doc.text(etiqueta, 50, y, { lineBreak: false });
      doc.text(valor, 170, y, { lineBreak: false });
      doc.text(unidad, 230, y, { lineBreak: false });
      if (rango) doc.text(rango, 300, y, { lineBreak: false });
      y += 15;
    }
    doc.end();
  });
}

const hemograma = (n, hb) =>
  informe({
    cabecera: [
      ['Nombre pac.', `Caballo ${n}`],
      ['Dueño', 'Juan Pérez'],
      ['Teléfono', '999888777'],
      ['Edad', '3 a'],
      ['Sexo', 'Hembra'],
      ['Fecha', '23/03/2025'],
    ],
    filas: [
      ['LEU', '7.43', '10^9/l', '5.40-14.30'],
      ['Hb', hb, 'g/dl', '11.0-19.0'],
      ['LYM%', '30.7', '%', '0.0-100.0'],
    ],
  });

const bioquimica = (n) =>
  informe({
    cabecera: [
      ['Id del pac.', `CAB0${n}`],
      ['Especies', 'Equino'],
      ['Fecha', '23/03/2025'],
    ],
    filas: [
      ['ALB', '3.2', 'g/dL', '2.1-4.3'],
      ['GLU', '85', 'mg/dL', '63-136'],
    ],
  });

async function zipDe(archivos) {
  const zip = new AdmZip();
  for (const [ruta, bytes] of archivos) zip.addFile(ruta, bytes);
  return zip.toBuffer();
}

test('dos casos con dos informes cada uno: dos filas, sin datos personales', async () => {
  const zip = await zipDe([
    ['data/CAB 01.pdf', await hemograma(1, '15.1')],
    ['data/CAB01.pdf', await bioquimica(1)],
    ['data/CAB 02.pdf', await hemograma(2, '13,4')],
    ['data/CAB02.pdf', await bioquimica(2)],
  ]);
  assert.equal(documentos.esLote(zip), true);

  const p = await documentos.preparar(zip);
  assert.equal(p.tipo, 'documentos');
  assert.equal(p.archivo, 'datos.csv');
  assert.equal(p.lectura, 'datos <- read.csv("datos.csv")');

  const [cabecera, ...filas] = p.contenido.toString('utf8').split('\n');
  assert.equal(cabecera, 'id,fecha,edad_anios,sexo,especie,LEU,Hb,LYM_pct,ALB,GLU,archivos');
  assert.deepEqual(filas, [
    'CAB 01,2025-03-23,3,Hembra,Equino,7.43,15.1,30.7,3.2,85,CAB 01.pdf + CAB01.pdf',
    'CAB 02,2025-03-23,3,Hembra,Equino,7.43,13.4,30.7,3.2,85,CAB 02.pdf + CAB02.pdf',
  ]);

  const todo = p.contenido.toString('utf8');
  assert.doesNotMatch(todo, /Juan|Pérez|999888777|Caballo 1/, 'ni el dueño, ni el teléfono, ni el nombre');
  assert.match(p.origen, /NO ENTRARON/);
  assert.match(p.origen, /Hb \(g\/dl\)/, 'Claude sabe la unidad de cada columna');
  assert.match(p.aviso, /4 PDF: 2 filas/);
});

test('el mismo análisis repetido con otros valores es otra toma, no se pisa', async () => {
  const zip = await zipDe([
    ['CAB01 marzo.pdf', await hemograma(1, '15.1')],
    ['CAB01 abril.pdf', await hemograma(1, '12.0')],
  ]);
  const p = await documentos.preparar(zip);
  const [cabecera, ...filas] = p.contenido.toString('utf8').split('\n');
  assert.ok(cabecera.startsWith('id,toma,'));
  assert.equal(filas.length, 2);
  assert.deepEqual(filas.map((f) => f.split(',')[1]), ['1', '2']);
  // Con la misma fecha van por el nombre del archivo: abril antes que marzo.
  assert.match(filas[0], /,12,.*CAB01 abril\.pdf$/);
  assert.match(filas[1], /,15\.1,.*CAB01 marzo\.pdf$/);
});

test('el caso al que le falta un informe se avisa', async () => {
  const zip = await zipDe([
    ['CAB 01.pdf', await hemograma(1, '15.1')],
    ['CAB01.pdf', await bioquimica(1)],
    ['CAB 02.pdf', await hemograma(2, '14')],
    ['CAB02.pdf', await bioquimica(2)],
    ['CAB 03.pdf', await hemograma(3, '13')],
  ]);
  const p = await documentos.preparar(zip);
  assert.ok(p.revisar.some((r) => /1 tiene menos: CAB 03/.test(r)), p.revisar.join(' | '));
});

test('un PDF suelto también vale', async () => {
  const p = await documentos.preparar(await hemograma(1, '15.1'));
  assert.equal(p.contenido.toString('utf8').split('\n').length, 2);
});

test('un .zip con hojas de cálculo y sin PDF dice qué hacer', async () => {
  const zip = await zipDe([
    ['a.xlsx', Buffer.from('x')],
    ['b.xlsx', Buffer.from('y')],
  ]);
  assert.equal(documentos.esLote(zip), true);
  await assert.rejects(documentos.preparar(zip), (e) => e instanceof ArchivoNoValido && /una sola matriz/.test(e.message));
});

test('un Excel de verdad (que también es un .zip) no es un lote', async () => {
  const xlsx = await zipDe([
    ['[Content_Types].xml', Buffer.from('<Types/>')],
    ['xl/workbook.xml', Buffer.from('<workbook/>')],
  ]);
  assert.equal(documentos.esLote(xlsx), false);
  assert.equal(await documentos.preparar(xlsx), null);
});

test('PDF sin texto (escaneados): se dice que son imágenes', async () => {
  const vacio = await new Promise((resolver) => {
    const doc = new PDFDocument();
    const partes = [];
    doc.on('data', (p) => partes.push(p));
    doc.on('end', () => resolver(Buffer.concat(partes)));
    doc.rect(50, 50, 100, 100).fill('#333');
    doc.end();
  });
  const zip = await zipDe([
    ['a.pdf', vacio],
    ['b.pdf', vacio],
  ]);
  await assert.rejects(documentos.preparar(zip), (e) => e instanceof ArchivoNoValido && /escaneadas/.test(e.message));
});

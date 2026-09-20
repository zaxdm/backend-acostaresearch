'use strict';

/**
 * El material del curso del informe: la consigna, la rúbrica o el índice que el
 * estudiante sube por un enlace para que Claude lo lea.
 *
 * Lo que tiene que ser cierto:
 *
 *   · de un Word se lee el texto en orden, con los títulos y el índice marcados;
 *   · de un PDF se leen sus párrafos y de un Excel una línea por fila;
 *   · una foto o un PDF escaneado se rechazan con un mensaje que manda al chat;
 *   · se guardan hasta cinco, el mismo nombre reemplaza, y se leen por partes;
 *   · el enlace es suyo y no vale como enlace del formato;
 *   · la herramienta solo existe en el conector del informe.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Document, Packer, Paragraph, HeadingLevel } = require('docx');

const { pdfCon, excelCon } = require('./ayudas/archivos');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const INFORME = 'INFORME_PRUEBA01';
const TESIS = 'METODO_DE_TESIS_HUMANIZADOR';

const estado = { proyecto: { id: 'p1', stages: [] }, material: null, conLicencia: [INFORME] };

sustituir('../src/modules/projects/project.repository', {
  productosConLicencia: async () => estado.conLicencia,
  buscar: async () => estado.proyecto,
  asegurar: async () => estado.proyecto,
  guardarEtapa: async () => ({}),
  listarDeUsuario: async () => [],
});
sustituir('../src/modules/projects/project.storage', {
  leerMaterial: async () => (estado.material ? structuredClone(estado.material) : null),
  guardarMaterial: async (projectId, lista) => {
    estado.material = lista && lista.length > 0 ? structuredClone(lista) : null;
  },
  leer: async () => null,
  fechaDeAnalisis: async () => null,
});

const rutaMcp = require.resolve('@modelcontextprotocol/server');
const mcpReal = require('@modelcontextprotocol/server');
let registradas = null;
require.cache[rutaMcp] = {
  id: rutaMcp,
  filename: rutaMcp,
  loaded: true,
  exports: {
    fromJsonSchema: mcpReal.fromJsonSchema,
    McpServer: class {
      registerTool(nombre, config) {
        registradas.set(nombre, config);
      }
    },
  },
};

const material = require('../src/modules/projects/project.material');
const materialService = require('../src/modules/projects/material.service');
const subidaMaterial = require('../src/modules/projects/project.subida-material');
const subidaFormato = require('../src/modules/projects/project.subida-formato');
const { construirServidor } = require('../src/modules/mcp/mcp.tools');

async function wordDeIndice() {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: 'Estructura del informe', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: '1. Introducción' }),
          new Paragraph({ text: '6.1 Resultados del proyecto', heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ text: '' }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

function empezar() {
  estado.proyecto = { id: 'p1', stages: [] };
  estado.material = null;
  estado.conLicencia = [INFORME];
}

// ── Leer ───────────────────────────────────────────────────────────────────

test('de un Word se lee el texto en orden, con los títulos marcados y sin líneas vacías', async () => {
  const texto = await material.textoDe(await wordDeIndice());
  assert.deepEqual(texto.split('\n'), [
    '[Título 1] Estructura del informe',
    '1. Introducción',
    '[Título 2] 6.1 Resultados del proyecto',
  ]);
});

test('de un PDF con texto salen sus párrafos: así llegan los términos de referencia', async () => {
  const texto = await material.textoDe(
    pdfCon([
      'TÉRMINOS DE REFERENCIA',
      'El consultor entregará un diagnóstico del área de logística de la',
      'empresa, con recomendaciones priorizadas.',
      '',
      'Plazo: 30 días calendario desde la firma del contrato.',
      '1',
    ]),
  );

  assert.match(texto, /TÉRMINOS DE REFERENCIA/);
  // Los dos renglones de la misma frase vuelven a ser un párrafo.
  assert.match(texto, /diagnóstico del área de logística de la empresa, con recomendaciones priorizadas\./);
  // El número de página suelto no es texto de nadie.
  assert.equal(/^1$/m.test(texto), false);
});

test('un PDF escaneado, una foto o un .doc antiguo se rechazan diciendo qué hacer', async () => {
  await assert.rejects(
    () => material.textoDe(pdfCon([])),
    (e) => e instanceof material.MaterialNoValido && /escaneado/.test(e.message),
  );
  await assert.rejects(() => material.textoDe(Buffer.from('89504e470d0a1a0a00000000', 'hex')), /chat de tu asistente/);
  await assert.rejects(() => material.textoDe(Buffer.from('ffd8ffe000104a4649460001', 'hex')), /chat de tu asistente/);
  await assert.rejects(() => material.textoDe(Buffer.from('d0cf11e0a1b11ae100000000', 'hex')), /antiguo de Office/);
});

test('de un Excel sale una línea por fila, con su hoja delante y en el orden de las pestañas', async () => {
  const texto = await material.textoDe(
    excelCon([
      {
        nombre: 'Rúbrica',
        filas: [
          ['Criterio', 'Peso', 'Descripción'],
          [],
          ['Redacción & estilo', 20, 'Claridad y ortografía'],
          [null, null, 'Sin criterio: solo una nota suelta'],
        ],
      },
      { nombre: 'Entrega', filas: [['Fecha', '30/09/2026']] },
    ]),
  );

  assert.deepEqual(texto.split('\n'), [
    '[Hoja] Rúbrica',
    'Criterio | Peso | Descripción',
    'Redacción & estilo | 20 | Claridad y ortografía',
    'Sin criterio: solo una nota suelta',
    '[Hoja] Entrega',
    'Fecha | 30/09/2026',
  ]);
});

test('un Excel sin nada escrito se rechaza', async () => {
  await assert.rejects(
    () => material.textoDe(excelCon([{ nombre: 'Hoja1', filas: [[], []] }])),
    (e) => e instanceof material.MaterialNoValido && /nada escrito/.test(e.message),
  );
});

test('el texto plano se acepta tal cual; uno vacío, no', async () => {
  assert.equal(await material.textoDe(Buffer.from('Consigna:\r\n1. Introducción\r\n')), 'Consigna:\n1. Introducción');
  await assert.rejects(() => material.textoDe(Buffer.from('   \n ')), /no tiene texto/);
});

test('lo que pasa de 60.000 caracteres se recorta y se avisa', async () => {
  const largo = await material.textoDe(Buffer.from('a'.repeat(70_000)));
  assert.ok(largo.length < 60_200);
  assert.match(largo, /no se guardó/);
});

test('las partes se cortan entre líneas y no pierden nada', () => {
  const lineas = Array.from({ length: 3000 }, (_, i) => `Línea ${i} con algo de texto para ocupar sitio`);
  const partes = material.enPartes(lineas.join('\n'));
  assert.ok(partes.length > 1);
  assert.ok(partes.every((p) => p.length <= material.POR_PARTE));
  assert.equal(partes.join('\n'), lineas.join('\n'));
});

// ── Guardar ────────────────────────────────────────────────────────────────

test('se guarda, se lista sin el texto y se lee por su número', async () => {
  empezar();
  const r = await materialService.guardar({ userId: 'u1', productCode: INFORME, buffer: await wordDeIndice(), nombre: 'indice.docx' });
  assert.equal(r.nombre, 'indice.docx');

  const lista = await materialService.lista('u1', INFORME);
  assert.deepEqual(lista.map((m) => [m.numero, m.nombre]), [[1, 'indice.docx']]);
  assert.equal('texto' in lista[0], false, 'la lista no lleva el texto');

  const leido = await materialService.leer('u1', INFORME, 1);
  assert.match(leido.texto, /6\.1 Resultados del proyecto/);
  assert.equal(await materialService.leer('u1', INFORME, 2), null);
});

test('el mismo nombre reemplaza; el sexto archivo distinto no cabe', async () => {
  empezar();
  const subir = (nombre, texto = 'Rúbrica') =>
    materialService.guardar({ userId: 'u1', productCode: INFORME, buffer: Buffer.from(texto), nombre });

  await subir('rubrica.txt', 'Versión 1');
  await subir('rubrica.txt', 'Versión 2');
  assert.equal(estado.material.length, 1);
  assert.equal(estado.material[0].texto, 'Versión 2');

  for (const n of [2, 3, 4, 5]) await subir(`archivo-${n}.txt`);
  await assert.rejects(() => subir('sexto.txt'), material.MaterialNoValido);
});

test('sin licencia de ese método no se guarda nada', async () => {
  empezar();
  estado.conLicencia = [];
  assert.equal(await materialService.guardar({ userId: 'u1', productCode: INFORME, buffer: Buffer.from('x'), nombre: 'a.txt' }), null);
  assert.equal(estado.material, null);
});

test('quitar por número deja los demás', async () => {
  empezar();
  await materialService.guardar({ userId: 'u1', productCode: INFORME, buffer: Buffer.from('uno'), nombre: 'uno.txt' });
  await materialService.guardar({ userId: 'u1', productCode: INFORME, buffer: Buffer.from('dos'), nombre: 'dos.txt' });
  assert.deepEqual(await materialService.quitar('u1', INFORME, 1), { nombre: 'uno.txt' });
  assert.deepEqual((await materialService.lista('u1', INFORME)).map((m) => m.nombre), ['dos.txt']);
  assert.equal(await materialService.quitar('u1', INFORME, 9), null);
});

// ── El enlace ──────────────────────────────────────────────────────────────

test('el enlace del material es suyo y no vale como enlace del formato', () => {
  const { url, minutos } = subidaMaterial.enlace({ userId: 'u1', productCode: INFORME });
  assert.equal(minutos, 30);
  const token = url.split('/subir-material/')[1];
  assert.deepEqual(
    (({ userId, productCode }) => ({ userId, productCode }))(subidaMaterial.verificar(token)),
    { userId: 'u1', productCode: INFORME },
  );
  assert.throws(() => subidaFormato.verificar(token));

  const deFormato = subidaFormato.enlace({ userId: 'u1', productCode: INFORME }).url.split('/subir-formato/')[1];
  assert.throws(() => subidaMaterial.verificar(deFormato));
});

// ── El conector ────────────────────────────────────────────────────────────

function herramientas(productCode) {
  registradas = new Map();
  construirServidor({ productCode });
  return registradas;
}

test('material_del_curso solo existe en el conector del informe', () => {
  const informe = herramientas(INFORME);
  assert.ok(informe.has('material_del_curso'));
  assert.match(informe.get('material_del_curso').description, /ENLACE/);
  assert.match(informe.get('material_del_curso').description, /adjunte/);
  assert.match(informe.get('material_del_curso').description, /PDF, Excel/);

  assert.equal(herramientas(TESIS).has('material_del_curso'), false);
  assert.equal(herramientas('ARTICULO_SCIENTIFICOS').has('material_del_curso'), false);
});

test('la línea del panorama dice qué hay y cómo leerlo', () => {
  assert.match(material.lineaDeMaterial([]), /nada subido/);
  assert.match(material.lineaDeMaterial([{ nombre: 'rubrica.docx' }]), /1\. rubrica\.docx/);
});

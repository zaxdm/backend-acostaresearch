'use strict';

/**
 * El análisis cualitativo de punta a punta, sin base ni disco: subir, listar,
 * leer por tandas, codificar y la herramienta «analisis_cualitativo».
 *
 * Lo que tiene que ser cierto:
 *
 *   · cada entrevista recibe su número (E1, E2…) y lo conserva al volver a
 *     subirla, pero pierde sus citas;
 *   · «ver» reparte los párrafos en tandas y dice por dónde seguir;
 *   · una codificación con una cita inventada no se guarda;
 *   · la herramienta existe en tesis, artículo e informe, y su enlace es suyo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const TESIS = 'METODO_DE_TESIS_HUMANIZADOR';
const ARTICULO = 'ARTICULO_SCIENTIFICOS';
const INFORME = 'INFORME_PRUEBA01';

const estado = { proyecto: { id: 'p1', stages: [] }, archivos: {}, conLicencia: [TESIS] };

sustituir('../src/modules/projects/project.repository', {
  productosConLicencia: async () => estado.conLicencia,
  buscar: async () => estado.proyecto,
  asegurar: async () => estado.proyecto,
  guardarEtapa: async () => ({}),
  listarDeUsuario: async () => [],
});
sustituir('../src/modules/projects/project.storage', {
  leerCualitativo: async (projectId, que) => structuredClone(estado.archivos[que] ?? null),
  guardarCualitativo: async (projectId, que, valor) => {
    estado.archivos[que] = valor === null || valor === undefined ? null : structuredClone(valor);
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
      registerTool(nombre, config, handler) {
        registradas.set(nombre, { config, handler });
      }
    },
  },
};

const licenseService = require('../src/modules/licensing/license.service');
licenseService.recordUsage = async () => {};

const servicio = require('../src/modules/cualitativo/cualitativo.service');
const enlaces = require('../src/modules/cualitativo/cualitativo.enlaces');
const subidaMaterial = require('../src/modules/projects/project.subida-material');
const { construirServidor } = require('../src/modules/mcp/mcp.tools');

const txt = (lineas) => Buffer.from(lineas.join('\n'), 'utf8');

const ENTREVISTA_1 = [
  'Entrevistador: ¿Cómo fue su experiencia con el asesor?',
  'Participante: El profesor nunca respondía mis correos, tuve que buscar ayuda afuera.',
];

function empezar() {
  estado.proyecto = { id: 'p1', stages: [] };
  estado.archivos = {};
  estado.conLicencia = [TESIS];
}

function herramientas(productCode) {
  registradas = new Map();
  construirServidor({ productCode, id: 'l1', user: { id: 'u1' } });
  return registradas;
}

async function llamar(args, productCode = TESIS) {
  const { handler } = herramientas(productCode).get('analisis_cualitativo');
  const respuesta = await handler(args);
  return respuesta.content[0].text;
}

test('subir: numera E1, E2… y la lista no lleva el texto', async () => {
  empezar();
  const a = await servicio.guardar({ userId: 'u1', productCode: TESIS, buffer: txt(ENTREVISTA_1), nombre: 'ana.txt' });
  const b = await servicio.guardar({ userId: 'u1', productCode: TESIS, buffer: txt(['P: Hola.']), nombre: 'luis.txt' });
  assert.equal(a.id, 'E1');
  assert.equal(b.id, 'E2');
  const lista = await servicio.lista('u1', TESIS);
  assert.deepEqual(lista.map((e) => [e.id, e.nombre, e.parrafos]), [['E1', 'ana.txt', 2], ['E2', 'luis.txt', 1]]);
  assert.equal(typeof lista[0].parrafos, 'number', 'la lista lleva cuántos párrafos, no el texto');
});

test('sin licencia de ese método no se guarda', async () => {
  empezar();
  estado.conLicencia = [];
  assert.equal(await servicio.guardar({ userId: 'u1', productCode: TESIS, buffer: txt(ENTREVISTA_1), nombre: 'a.txt' }), null);
});

test('volver a subir con el mismo nombre conserva el número y quita sus citas', async () => {
  empezar();
  await servicio.guardar({ userId: 'u1', productCode: TESIS, buffer: txt(ENTREVISTA_1), nombre: 'ana.txt' });
  await servicio.codificar('u1', TESIS, 'E1', {
    codigos: [{ nombre: 'Apoyo', definicion: 'x' }],
    citas: [{ parrafo: 2, texto: 'nunca respondía', codigos: ['Apoyo'] }],
  });
  const otra = await servicio.guardar({ userId: 'u1', productCode: TESIS, buffer: txt(ENTREVISTA_1), nombre: 'ana.txt' });
  assert.equal(otra.id, 'E1');
  assert.equal(otra.reemplazo, true);
  assert.equal(otra.citasPerdidas, 1);
  assert.equal(estado.archivos.codificacion.citas.length, 0);
  assert.equal(estado.archivos.codificacion.codigos.length, 1, 'el libro se queda');
});

test('ver: reparte en tandas y dice por dónde seguir', async () => {
  empezar();
  const largo = Array.from({ length: 40 }, (_, i) => `P: Respuesta ${i + 1}. ${'palabra '.repeat(80)}`);
  await servicio.guardar({ userId: 'u1', productCode: TESIS, buffer: txt(largo), nombre: 'larga.txt' });
  const primera = await servicio.ver('u1', TESIS, 'e1');
  assert.ok(primera.siguiente > 1);
  assert.ok(primera.parrafos.reduce((s, p) => s + p.texto.length, 0) <= servicio.POR_TANDA);
  const segunda = await servicio.ver('u1', TESIS, 'E1', { desde: primera.siguiente });
  assert.equal(segunda.parrafos[0].numero, primera.siguiente);
  assert.equal(await servicio.ver('u1', TESIS, 'E9'), null);
});

test('la herramienta: lista vacía con su enlace, que no vale como el del material', async () => {
  empezar();
  const respuesta = await llamar({});
  assert.match(respuesta, /Todavía no ha subido ninguna entrevista/);
  const url = /https?:\/\/\S+\/subir-entrevistas\/([^\s)]+)/.exec(respuesta);
  assert.ok(url, 'da el enlace de subida');
  assert.equal(enlaces.verificar(url[1]).userId, 'u1');
  assert.throws(() => subidaMaterial.verificar(url[1]));
});

test('la herramienta: ver, codificar con una cita inventada (no guarda) y bien (guarda)', async () => {
  empezar();
  await servicio.guardar({ userId: 'u1', productCode: TESIS, buffer: txt(ENTREVISTA_1), nombre: 'ana.txt' });

  assert.match(await llamar({ accion: 'ver', entrevista: 'E1' }), /¶2 Participante: El profesor nunca/);

  const mal = await llamar({
    accion: 'codificar',
    entrevista: 'E1',
    codigos: [{ nombre: 'Falta de apoyo docente', definicion: 'El docente no orienta.' }],
    citas: [{ parrafo: 2, texto: 'el profesor jamás contestaba', codigos: ['Falta de apoyo docente'] }],
  });
  assert.match(mal, /No se guardó nada/);
  assert.equal(estado.archivos.codificacion ?? null, null);

  const bien = await llamar({
    accion: 'codificar',
    entrevista: 'E1',
    codigos: [{ nombre: 'Falta de apoyo docente', definicion: 'El docente no orienta.', categoria: 'Barreras' }],
    citas: [{ parrafo: 2, texto: 'El profesor nunca respondía mis correos', codigos: ['Falta de apoyo docente'] }],
  });
  assert.match(bien, /1 citas, todas comprobadas/);

  const libro = await llamar({ accion: 'libro' });
  assert.match(libro, /Barreras\n- Falta de apoyo docente \(1 citas, 1 entrevistas\)/);
  assert.match(libro, /E1 · «ana\.txt» · 2 párrafos · 1 citas codificadas/);
});

test('la herramienta: «codificar» sin citas no borra lo guardado', async () => {
  empezar();
  await servicio.guardar({ userId: 'u1', productCode: TESIS, buffer: txt(ENTREVISTA_1), nombre: 'ana.txt' });
  await servicio.codificar('u1', TESIS, 'E1', {
    codigos: [{ nombre: 'Apoyo', definicion: 'x' }],
    citas: [{ parrafo: 2, texto: 'nunca respondía', codigos: ['Apoyo'] }],
  });
  assert.match(await llamar({ accion: 'codificar', entrevista: 'E1' }), /No se guardó nada/);
  assert.equal(estado.archivos.codificacion.citas.length, 1);
});

test('la herramienta está en tesis, artículo e informe', () => {
  for (const producto of [TESIS, ARTICULO, INFORME]) {
    assert.ok(herramientas(producto).has('analisis_cualitativo'), producto);
  }
});

// ── Tablas, red, capítulo y .qdpx, con un motor de R de mentira ─────────────

const AdmZip = require('adm-zip');
const rService = require('../src/modules/r/r.service');

/** Un PNG de 1×1 de verdad: el Word lo mide antes de incrustarlo. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function motorFalso() {
  const archivos = new Map();
  const ordenes = [];
  return {
    archivos,
    ordenes,
    listo: async () => true,
    guardarArchivo: async (sesion, nombre, bytes) => archivos.set(`${sesion}/${nombre}`, bytes),
    leerArchivo: async (sesion, nombre) => archivos.get(`${sesion}/${nombre}`) ?? null,
    ejecutar: async (sesion, codigo) => {
      ordenes.push({ sesion, codigo });
      archivos.set(`${sesion}/red-de-codigos.png`, PNG);
      return { resultado: 'ok', salida: 'Red de codigos: 2 codigos, 1 lazos' };
    },
  };
}

async function codificarDePrueba() {
  empezar();
  await servicio.guardar({ userId: 'u1', productCode: TESIS, buffer: txt(ENTREVISTA_1), nombre: 'ana.txt' });
  await servicio.codificar('u1', TESIS, 'E1', {
    codigos: [
      { nombre: 'Falta de apoyo docente', definicion: 'El docente no orienta.', categoria: 'Barreras' },
      { nombre: 'Ayuda externa', definicion: 'Busca apoyo fuera.', categoria: 'Estrategias' },
    ],
    citas: [
      { parrafo: 2, texto: 'El profesor nunca respondía mis correos', codigos: ['Falta de apoyo docente'] },
      { parrafo: 2, texto: 'tuve que buscar ayuda afuera.', codigos: ['Ayuda externa', 'Falta de apoyo docente'] },
    ],
  });
}

test('la herramienta: tablas calculadas por el servidor, listas para pegar', async () => {
  await codificarDePrueba();
  const respuesta = await llamar({ accion: 'tablas' });
  assert.match(respuesta, /\*\*Tabla X\*\*\n\*Frecuencia de los códigos por entrevista\*/);
  assert.match(respuesta, /\| Ayuda externa \| Falta de apoyo docente \| 1 \| 0,50 \|/);
});

test('la herramienta: la red se dibuja en una sesión aparte y queda en la del proyecto', async () => {
  await codificarDePrueba();
  const m = motorFalso();
  rService.usarMotor(m);
  try {
    const respuesta = await llamar({ accion: 'red' });
    assert.match(respuesta, /Red dibujada: 2 códigos y 1 lazos/);
    assert.match(respuesta, /!\[\]\(red-de-codigos\.png\)/);
    assert.equal(m.ordenes.length, 1);
    assert.equal(m.ordenes[0].sesion, 'p1-cual', 'no en la sesión del análisis cuantitativo');
    assert.ok(m.archivos.has('p1-cual/red-nodos.csv'));
    assert.ok(m.archivos.has('p1/red-de-codigos.png'));
  } finally {
    rService.usarMotor(null);
  }
});

test('la herramienta: el capítulo con una cita inventada no se arma; con las buenas, sí', async () => {
  await codificarDePrueba();
  const m = motorFalso();
  m.archivos.set('p1/red-de-codigos.png', PNG);
  rService.usarMotor(m);
  try {
    const inventado = await llamar({
      accion: 'capitulo',
      titulo: 'CAPÍTULO IV\nRESULTADOS',
      texto: 'Dijo que «el profesor jamás contestaba ninguno de mis correos» (E1, ¶2).',
    });
    assert.match(inventado, /NO SE ARMÓ EL WORD: 1 citas no están/);
    assert.equal(m.archivos.has('p1/capitulo-cualitativo.docx'), false);

    const bueno = await llamar({
      accion: 'capitulo',
      titulo: 'CAPÍTULO IV\nRESULTADOS',
      texto: [
        '# 4.1 Barreras',
        'Una participante contó que «el profesor nunca respondía mis correos» (E1, ¶2).',
        '**Figura 1**\n*Red de coocurrencia de los códigos*\n![](red-de-codigos.png)\n*Nota.* Elaborado en R.',
      ].join('\n\n'),
    });
    assert.match(bueno, /Capítulo listo: 0 tablas, 1 figuras y 1 citas textuales/);
    const word = m.archivos.get('p1/capitulo-cualitativo.docx');
    const xml = new AdmZip(word).getEntry('word/document.xml').getData().toString('utf8');
    assert.match(xml, /el profesor nunca respondía mis correos/);
    assert.match(xml, /<pic:pic/, 'la red va incrustada');
  } finally {
    rService.usarMotor(null);
  }
});

test('la herramienta: el .qdpx queda en la sesión, y sin R lo dice sin romper', async () => {
  await codificarDePrueba();
  const m = motorFalso();
  rService.usarMotor(m);
  try {
    assert.match(await llamar({ accion: 'qdpx' }), /Proyecto listo: 1 entrevistas, 2 códigos y 2 citas/);
    assert.ok(new AdmZip(m.archivos.get('p1/analisis-cualitativo.qdpx')).getEntry('project.qde'));
    m.listo = async () => false;
    assert.match(await llamar({ accion: 'qdpx' }), /servidor de R no está disponible/);
  } finally {
    rService.usarMotor(null);
  }
});

test('sin nada codificado, tablas, red, capítulo y qdpx lo dicen', async () => {
  empezar();
  for (const accion of ['tablas', 'red', 'qdpx']) {
    assert.match(await llamar({ accion }), /Todavía no hay nada codificado/, accion);
  }
  assert.match(await llamar({ accion: 'capitulo', texto: 'Algo.' }), /Todavía no hay nada codificado/);
});

// ── Citas, búsqueda, atributos y memos ─────────────────────────────────────

test('la herramienta: «citas» devuelve las citas de un código, no solo cuántas', async () => {
  await codificarDePrueba();
  const respuesta = await llamar({ accion: 'citas', codigo: 'falta de apoyo DOCENTE' });
  assert.match(respuesta, /Citas de el código «Falta de apoyo docente»: 2/);
  assert.match(respuesta, /E1 ¶2 · Falta de apoyo docente\n«El profesor nunca respondía mis correos»/);
  assert.match(await llamar({ accion: 'citas', codigo: 'Inventado' }), /No hay ninguna código/);
});

test('la herramienta: «buscar» encuentra el párrafo y no pide tildes ni mayúsculas', async () => {
  await codificarDePrueba();
  const respuesta = await llamar({ accion: 'buscar', busca: 'respondia MIS correos' });
  assert.match(respuesta, /aparece en 1 párrafos/);
  assert.match(respuesta, /E1 ¶2/);
  assert.match(await llamar({ accion: 'buscar', busca: 'jubilación' }), /no aparece/);
  assert.match(await llamar({ accion: 'buscar', busca: 'de' }), /al menos tres letras/);
});

test('la herramienta: los atributos de una entrevista dan la tabla comparativa', async () => {
  empezar();
  for (const [nombre, rol] of [['ana.txt', 'Estudiante'], ['luis.txt', 'Docente']]) {
    await servicio.guardar({ userId: 'u1', productCode: TESIS, buffer: txt(ENTREVISTA_1), nombre });
  }
  await llamar({ accion: 'atributos', entrevista: 'E1', atributos: { Rol: 'Estudiante' } });
  const puesta = await llamar({ accion: 'atributos', entrevista: 'E2', atributos: { Rol: 'Docente' } });
  assert.match(puesta, /E2 .* queda con Rol: Docente/);

  for (const id of ['E1', 'E2']) {
    await servicio.codificar('u1', TESIS, id, {
      codigos: [{ nombre: 'Apoyo', definicion: 'x', categoria: 'Barreras' }],
      citas: [{ parrafo: 2, texto: 'nunca respondía', codigos: ['Apoyo'] }],
    });
  }
  const tablas = await llamar({ accion: 'tablas' });
  assert.match(tablas, /\*Frecuencia de los códigos según rol\*/);
  assert.match(tablas, /\| Categoría \| Código \| Docente \| Estudiante \| Total \|/);
});

test('los memos: se escriben sobre un código, siguen al renombrarlo y salen en el .qdpx', async () => {
  await codificarDePrueba();
  assert.match(
    await llamar({ accion: 'memo', tipo: 'codigo', sobre: 'falta de apoyo docente', nota: 'Aparece en todas.' }),
    /Memo m1 guardado. Es sobre: Código «Falta de apoyo docente»/,
  );
  assert.match(await llamar({ accion: 'memo', tipo: 'analisis', nota: 'Saturación en la E3.' }), /Memo m2/);
  assert.match(
    await llamar({ accion: 'memo', tipo: 'codigo', sobre: 'No existe', nota: 'x' }),
    /No se guardó nada|No hay ningún código/,
  );

  await llamar({ accion: 'renombrar', de: 'Falta de apoyo docente', a: 'Abandono del asesor' });
  const memos = await llamar({ accion: 'memos' });
  assert.match(memos, /Código «Abandono del asesor»/, 'el memo sigue a su código');

  const m = motorFalso();
  rService.usarMotor(m);
  try {
    await llamar({ accion: 'qdpx' });
    const xml = new AdmZip(m.archivos.get('p1/analisis-cualitativo.qdpx'))
      .getEntry('project.qde')
      .getData()
      .toString('utf8');
    assert.match(xml, /Memo: Aparece en todas\./);
    assert.match(xml, /<Description>Memo \(\d{4}-\d{2}-\d{2}\): Saturación en la E3\.<\/Description>/);
  } finally {
    rService.usarMotor(null);
  }
});

test('el .qdpx lleva los atributos como variables de cada fuente', async () => {
  await codificarDePrueba();
  await llamar({ accion: 'atributos', entrevista: 'E1', atributos: { Rol: 'Estudiante', Sexo: 'Mujer' } });
  const m = motorFalso();
  rService.usarMotor(m);
  try {
    await llamar({ accion: 'qdpx' });
    const xml = new AdmZip(m.archivos.get('p1/analisis-cualitativo.qdpx'))
      .getEntry('project.qde')
      .getData()
      .toString('utf8');
    const rol = /<Variable guid="([^"]+)" name="Rol" typeOfVariable="Text"\/>/.exec(xml);
    assert.ok(rol, 'la variable existe');
    assert.match(xml, new RegExp(`<VariableRef targetGUID="${rol[1]}"/><TextValue>Estudiante</TextValue>`));
    assert.match(xml, /<Variable guid="[^"]+" name="Sexo"/);
  } finally {
    rService.usarMotor(null);
  }
});

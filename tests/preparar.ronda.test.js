'use strict';

/**
 * «Humanizar» en forma de conversación (24-oct-2026): los capítulos que no se
 * tocan, otra ronda con el reporte nuevo, «Rehacer un párrafo» y «todo otra
 * vez». Las rondas parten del Word ya entregado, no del original.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

function falsificar(ruta, exports) {
  const resuelta = require.resolve(ruta);
  require.cache[resuelta] = { id: resuelta, filename: resuelta, loaded: true, exports };
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function docx(lineas) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>` +
        lineas.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join('') +
        '</w:body></w:document>',
    ),
  );
  zip.addFile('word/styles.xml', Buffer.from(`<?xml version="1.0"?><w:styles xmlns:w="${W}"/>`));
  return zip.toBuffer();
}

const INTRO =
  'La empresa importadora cuenta con un almacén central en Pucallpa donde trabajan cuarenta operarios en dos turnos diarios de recepción y despacho.';
const RESULTADO =
  'Los resultados mostraron que el control interno se relacionó con la exactitud de los estados financieros en las municipalidades distritales estudiadas.';
const WORD = docx(['INTRODUCCIÓN', INTRO, 'RESULTADOS', RESULTADO]);

const env = { ...require('../src/config/env'), prepararEnabled: true, PREPARAR_ILIMITADO_EMAILS: '' };
falsificar('../src/config/env', env);

let filas;
let disco;
let pedidosAlHumanizador;

falsificar('../src/modules/preparar/preparar.repository', {
  rolDe: async () => 'ADMIN',
  correoDe: async () => 'admin@ejemplo.pe',
  mia: async (userId, id) => (filas.get(id)?.userId === userId ? filas.get(id) : null),
  crear: async (datos) => {
    const id = `00000000-0000-4000-8000-${String(filas.size + 1).padStart(12, '0')}`;
    const fila = { id, createdAt: new Date(), ...datos };
    filas.set(id, fila);
    return fila;
  },
  marcar: async (id, campos) => {
    filas.set(id, { ...filas.get(id), ...campos });
    return filas.get(id);
  },
  duenoDe: async () => null,
  listarDe: async () => [],
});

const enDisco = (id, archivo) => disco.get(`${id}/${archivo}`);
falsificar('../src/modules/preparar/preparar.storage', {
  guardarEntrada: async (id, b) => disco.set(`${id}/entrada`, b),
  guardarSalida: async (id, b) => disco.set(`${id}/salida`, b),
  leerEntrada: async (id) => enDisco(id, 'entrada'),
  leerSalida: async (id) => enDisco(id, 'salida'),
  haySalida: async (id) => disco.has(`${id}/salida`),
  guardarReporte: async (id, r) => disco.set(`${id}/reporte`, r),
  leerReporte: async (id) => enDisco(id, 'reporte') ?? null,
  guardarOpciones: async (id, o) => disco.set(`${id}/opciones`, o),
  leerOpciones: async (id) => enDisco(id, 'opciones') ?? {},
});

const humanizarReal = require('../src/modules/preparar/preparar.humanizar');
falsificar('../src/modules/preparar/preparar.humanizar', {
  ...humanizarReal,
  humanizar: async ({ parrafos, soloClaves, excluir }) => {
    const prosa = humanizarReal
      .porCapitulos(parrafos)
      .filter((p) => (!soloClaves || soloClaves.has(p.clave)) && !excluir?.has(p.clave));
    pedidosAlHumanizador.push(prosa.map((p) => p.texto));
    const cambios = {};
    for (const p of prosa) cambios[p.clave] = { original: p.texto, texto: `${p.texto} (rehecho)` };
    return { cambios, malos: [], uso: {} };
  },
});
falsificar('../src/lib/mailer', { sendMail: async () => {} });

const servicio = require('../src/modules/preparar/preparar.service');
const informe = require('../src/modules/preparar/preparar.reporte');
const reporteIa = require('../src/modules/projects/project.reporte-ia');
const cuerpo = require('../src/modules/preparar/preparar.cuerpo');

test.beforeEach(() => {
  filas = new Map();
  disco = new Map();
  pedidosAlHumanizador = [];
});

/** Espera a que la cola termine el trabajo. */
async function terminado(id) {
  for (let i = 0; i < 200 && !['LISTO', 'FALLIDO'].includes(filas.get(id)?.estado); i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return filas.get(id);
}

async function primeraEntrega(extra = {}) {
  const { preparacion } = await servicio.encargar({
    userId: 'u1',
    servicio: 'HUMANIZAR',
    idioma: null,
    buffer: WORD,
    nombre: 'tesis.docx',
    ...extra,
  });
  return terminado(preparacion.id);
}

test('los capítulos del Word salen con su título y solo los que tienen prosa', async () => {
  const { capitulos } = await servicio.capitulos({ userId: 'u1', buffer: WORD });
  assert.deepEqual(capitulos.map((c) => c.titulo), ['INTRODUCCIÓN', 'RESULTADOS']);
});

test('un capítulo marcado para no tocar no llega al humanizador', async () => {
  const { capitulos } = await servicio.capitulos({ userId: 'u1', buffer: WORD });
  const resultados = capitulos.find((c) => c.titulo === 'RESULTADOS');
  const hecho = await primeraEntrega({ noTocar: [resultados.clave] });
  assert.equal(hecho.estado, 'LISTO');
  assert.deepEqual(pedidosAlHumanizador, [[INTRO]]);
  const visto = await servicio.ver({ userId: 'u1', id: hecho.id });
  assert.deepEqual(visto.detalle.noTocar, ['RESULTADOS']);
});

test('marcar todos los capítulos se rechaza antes de encargar', async () => {
  const { capitulos } = await servicio.capitulos({ userId: 'u1', buffer: WORD });
  await assert.rejects(primeraEntrega({ noTocar: capitulos.map((c) => c.clave) }), /no queda nada que humanizar/);
  assert.equal(filas.size, 0);
});

test('otra ronda sin reporte parte del Word entregado y sigue sin tocar lo excluido', async () => {
  const { capitulos } = await servicio.capitulos({ userId: 'u1', buffer: WORD });
  const primera = await primeraEntrega({ noTocar: [capitulos.find((c) => c.titulo === 'RESULTADOS').clave] });
  const { preparacion } = await servicio.ronda({ userId: 'u1', id: primera.id });
  const segunda = await terminado(preparacion.id);
  assert.equal(segunda.estado, 'LISTO');
  assert.equal(segunda.nombre, 'tesis (ronda 2).docx');
  assert.deepEqual(pedidosAlHumanizador[1], [`${INTRO} (rehecho)`]);
});

test('rehacer un párrafo manda solo ese', async () => {
  const primera = await primeraEntrega();
  const { parrafos } = cuerpo.cuerpoDe(enDisco(primera.id, 'salida'), { todo: false });
  const claveResultado = humanizarReal.capitulosDe(parrafos).find((c) => c.titulo === 'RESULTADOS').claves[0];
  const { preparacion } = await servicio.ronda({ userId: 'u1', id: primera.id, clave: claveResultado });
  await terminado(preparacion.id);
  assert.deepEqual(pedidosAlHumanizador[1], [`${RESULTADO} (rehecho)`]);
  const visto = await servicio.ver({ userId: 'u1', id: preparacion.id });
  assert.equal(visto.detalle.parrafo, true);
  assert.equal(visto.detalle.deId, primera.id);
});

test('un título no se puede rehacer como párrafo', async () => {
  const primera = await primeraEntrega();
  const { capitulos } = await servicio.capitulos({ userId: 'u1', buffer: enDisco(primera.id, 'salida') });
  await assert.rejects(servicio.ronda({ userId: 'u1', id: primera.id, clave: capitulos[0].clave }), /no se puede rehacer/);
});

test('otra ronda con el reporte nuevo rehace solo lo marcado', async () => {
  const primera = await primeraEntrega();
  const palabras = [];
  const ia = [];
  for (const [texto, marcado] of [[`${INTRO} (rehecho)`, false], [`${RESULTADO} (rehecho)`, true]]) {
    for (const p of texto.split(/\s+/)) {
      const limpia = reporteIa.normalizar(p);
      if (!limpia) continue;
      palabras.push(limpia);
      ia.push(marcado ? '1' : '0');
    }
  }
  const reporteId = '00000000-0000-4000-8000-999999999999';
  informe._subidos.set(reporteId, { userId: 'u1', vence: Date.now() + 60_000, reporte: { palabras: palabras.join(' '), ia: ia.join('') } });
  const { preparacion } = await servicio.ronda({ userId: 'u1', id: primera.id, reporteId });
  await terminado(preparacion.id);
  assert.deepEqual(pedidosAlHumanizador[1], [`${RESULTADO} (rehecho)`]);
});

test('no se puede pedir otra ronda del documento de otro', async () => {
  const primera = await primeraEntrega();
  await assert.rejects(servicio.ronda({ userId: 'u2', id: primera.id }), /no es tuyo/);
});

test('el nombre de cada ronda sube de número', () => {
  assert.equal(servicio.nombreDeRonda('tesis.docx'), 'tesis (ronda 2).docx');
  assert.equal(servicio.nombreDeRonda('tesis (ronda 2).docx'), 'tesis (ronda 3).docx');
});

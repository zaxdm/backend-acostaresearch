'use strict';

/**
 * La biblioteca de formatos de universidad (28-oct).
 *
 * Lo que se prueba: que el tesista encuentra su universidad la diga como la
 * diga, sin que una sigla encuentre otra; que el grado filtra; que aplicar un
 * formato es subir su .docx por el camino de siempre y copia los capítulos solo
 * si son de su método y no tenía los suyos; que lo que sube un tesista entra
 * «por aprobar», sin repetirse; y que no se aprueba uno sin universidad. La
 * base, el proyecto y el catálogo se sustituyen; el disco es una carpeta
 * temporal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const temporal = fs.mkdtempSync(path.join(os.tmpdir(), 'formatos-'));
process.env.PROOFS_DIR = path.join(temporal, 'comprobantes');

const busqueda = require('../src/modules/formatos/formato.busqueda');

const fila = (datos) => ({ grado: 'cualquiera', alias: '', facultad: '', usos: 0, ...datos });

// ── La búsqueda ─────────────────────────────────────────────────────────────

test('la universidad se encuentra la diga como la diga', () => {
  const ucv = fila({ id: 'ucv', universidad: 'Universidad César Vallejo', alias: 'UCV, la César Vallejo' });
  const upn = fila({ id: 'upn', universidad: 'Universidad Privada del Norte', alias: 'UPN' });
  const filas = [ucv, upn];

  for (const dicho of ['UCV', 'ucv', 'César Vallejo', 'cesar vallejo', 'Universidad Cesar Vallejo', 'la U César Vallejo']) {
    assert.deepEqual(busqueda.buscar(filas, { universidad: dicho }).map((f) => f.id), ['ucv'], dicho);
  }
  assert.deepEqual(busqueda.buscar(filas, { universidad: 'upn' }).map((f) => f.id), ['upn']);
  assert.deepEqual(busqueda.buscar(filas, { universidad: 'San Marcos' }), []);
  assert.deepEqual(busqueda.buscar(filas, { universidad: '' }), []);
  assert.deepEqual(busqueda.buscar(filas, { universidad: 'Universidad' }), []);
});

test('una sigla solo encuentra la que la tiene escrita, no la que la contiene', () => {
  const otra = fila({ id: 'otra', universidad: 'Instituto UCV Satelital' });
  assert.deepEqual(busqueda.buscar([otra], { universidad: 'UCV' }), []);
});

test('el grado filtra, y un formato para cualquiera vale para los dos', () => {
  const pre = fila({ id: 'pre', universidad: 'Universidad Nacional de Trujillo', grado: 'pregrado' });
  const pos = fila({ id: 'pos', universidad: 'Universidad Nacional de Trujillo', grado: 'posgrado' });
  const todos = fila({ id: 'todos', universidad: 'Universidad Nacional de Trujillo', facultad: 'Derecho' });
  const filas = [pre, pos, todos];

  assert.deepEqual(busqueda.buscar(filas, { universidad: 'Nacional de Trujillo', grado: 'posgrado' }).map((f) => f.id), ['pos', 'todos']);
  assert.equal(busqueda.buscar(filas, { universidad: 'Nacional de Trujillo' }).length, 3);
  assert.equal(busqueda.etiqueta(pos), 'Universidad Nacional de Trujillo · posgrado');
  assert.equal(busqueda.etiqueta(todos), 'Universidad Nacional de Trujillo · Derecho');
});

// ── El servicio, con la base sustituida ─────────────────────────────────────

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const estado = { filas: new Map(), proyecto: null, subidas: [], esquemas: [] };
let siguiente = 0;

const coincideWhere = (f, where = {}) =>
  Object.entries(where).every(([k, v]) => (v && typeof v === 'object' && 'gt' in v ? f[k] > v.gt : f[k] === v));

sustituir('../src/lib/prisma', {
  formatoUniversidad: {
    create: async ({ data }) => {
      siguiente += 1;
      const id = `00000000-0000-4000-8000-${String(siguiente).padStart(12, '0')}`;
      const nueva = { id, universidad: '', alias: '', facultad: '', grado: 'cualquiera', notas: '', esquema: null, esquemaProducto: null, aprobado: true, origenProjectId: null, usos: 0, ...data };
      estado.filas.set(id, nueva);
      return { ...nueva };
    },
    findUnique: async ({ where }) => (estado.filas.has(where.id) ? { ...estado.filas.get(where.id) } : null),
    findFirst: async ({ where }) => [...estado.filas.values()].find((f) => coincideWhere(f, where)) ?? null,
    findMany: async ({ where } = {}) => [...estado.filas.values()].filter((f) => coincideWhere(f, where)).map((f) => ({ ...f })),
    update: async ({ where, data }) => {
      const f = estado.filas.get(where.id);
      for (const [k, v] of Object.entries(data)) f[k] = v && typeof v === 'object' && 'increment' in v ? f[k] + v.increment : v;
      return { ...f };
    },
    delete: async ({ where }) => estado.filas.delete(where.id),
  },
  plan: { findMany: async () => [] },
});
sustituir('../src/modules/projects/project.repository', {
  buscar: async () => estado.proyecto,
  asegurar: async (_u, _p, cambios) => Object.assign(estado.proyecto, cambios),
});
sustituir('../src/modules/projects/project.service', {
  guardarPlantilla: async ({ productCode, buffer, nombre }) => {
    if (productCode === 'SIN_LICENCIA') return null;
    estado.subidas.push({ productCode, bytes: buffer.length, nombre });
    return { estilos: [], mensaje: 'Plantilla guardada.' };
  },
  guardarEsquema: async ({ capitulos }) => {
    estado.esquemas.push(capitulos);
    return {};
  },
});
const CATALOGO = [
  { code: 'problema-y-objetivos', displayName: 'Introducción' },
  { code: 'marco-teorico', displayName: 'Marco teórico' },
  { code: 'metodologia', displayName: 'Metodología' },
];
sustituir('../src/modules/skills/skill.service', { listCatalog: async () => CATALOGO });

const formatoService = require('../src/modules/formatos/formato.service');

function docx(texto = 'formato') {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  zip.addFile('word/document.xml', Buffer.from(`<w:document>${texto}</w:document>`));
  zip.addFile('word/styles.xml', Buffer.from('<w:styles xmlns:w="x"><w:style w:styleId="Normal"/></w:styles>'));
  return zip.toBuffer();
}

const ESQUEMA = {
  capitulos: [
    { titulo: 'I. Introducción', de: ['problema-y-objetivos'] },
    { titulo: 'II. Marco teórico', de: ['marco-teorico'] },
    { titulo: 'III. Hipótesis' },
  ],
};

test('no se sube un archivo que no es .docx ni se aprueba uno sin universidad', async () => {
  await assert.rejects(formatoService.crear({ universidad: 'UCV' }, Buffer.from('%PDF-1.7'), 'x.pdf'), /no es un \.docx/);
  await assert.rejects(formatoService.crear({ universidad: '' }, docx(), 'x.docx'), /universidad/);
  const pendiente = await formatoService.crear({ universidad: '', aprobado: false }, docx('pendiente'), 'p.docx');
  await assert.rejects(formatoService.actualizar(pendiente.id, { aprobado: true }), /universidad/);
  const aprobado = await formatoService.actualizar(pendiente.id, { universidad: 'Universidad de Piura', aprobado: true });
  assert.equal(aprobado.aprobado, true);
  await formatoService.borrar(pendiente.id);
});

test('el esquema se comprueba contra el método y se puede vaciar', async () => {
  const f = await formatoService.crear({ universidad: 'Universidad Esquema' }, docx('esq'), 'e.docx');
  await assert.rejects(formatoService.actualizar(f.id, { esquema: ESQUEMA }), /método/);
  await assert.rejects(
    formatoService.actualizar(f.id, { esquema: { capitulos: [{ titulo: 'I', de: ['no-existe'] }] }, esquemaProducto: 'METODO' }),
    /no-existe/,
  );
  const con = await formatoService.actualizar(f.id, { esquema: ESQUEMA, esquemaProducto: 'METODO' });
  assert.equal(con.esquema.capitulos.length, 3);
  const sin = await formatoService.actualizar(f.id, { esquema: null });
  assert.equal(sin.esquemaProducto, null);
  await formatoService.borrar(f.id);
});

test('aplicar es subir su .docx por el camino de siempre, y los capítulos solo de su método', async () => {
  const f = await formatoService.crear({ universidad: 'Universidad César Vallejo', alias: 'UCV' }, docx('ucv'), 'ucv.docx');
  await formatoService.actualizar(f.id, { esquema: ESQUEMA, esquemaProducto: 'METODO' });

  estado.proyecto = { id: 'p1', esquema: null };
  estado.subidas.length = 0;
  estado.esquemas.length = 0;
  const r = await formatoService.aplicar({ userId: 'u1', productCode: 'METODO', formatoId: f.id });
  assert.equal(r.esquema, 'puesto');
  assert.equal(estado.subidas[0].nombre, 'De la biblioteca: Universidad César Vallejo');
  assert.equal(estado.subidas[0].bytes, f.bytes);
  assert.equal(estado.esquemas.length, 1);
  assert.equal(estado.filas.get(f.id).usos, 1);

  // Con sus propios capítulos, no se tocan.
  estado.proyecto = { id: 'p1', esquema: { capitulos: [{ titulo: 'Mío', clave: 'propio-mio' }] } };
  assert.equal((await formatoService.aplicar({ userId: 'u1', productCode: 'METODO', formatoId: f.id })).esquema, 'ya-tenia');
  // Otro método: el formato sí, los capítulos no.
  assert.equal((await formatoService.aplicar({ userId: 'u1', productCode: 'TSP_X', formatoId: f.id })).esquema, 'otro-metodo');
  assert.equal(estado.esquemas.length, 1);
  // Sin licencia, nada.
  assert.equal(await formatoService.aplicar({ userId: 'u1', productCode: 'SIN_LICENCIA', formatoId: f.id }), null);
  await formatoService.borrar(f.id);
});

test('lo que no está aprobado no se ofrece ni se aplica', async () => {
  const f = await formatoService.crear({ universidad: 'Universidad Oculta', aprobado: false }, docx('oculta'), 'o.docx');
  assert.deepEqual(await formatoService.buscar({ universidad: 'Universidad Oculta' }), []);
  await assert.rejects(formatoService.aplicar({ userId: 'u1', productCode: 'METODO', formatoId: f.id }), /no está en la biblioteca/);
  await formatoService.borrar(f.id);
});

test('la plantilla de un tesista entra por aprobar, una sola vez y solo de tesis', async () => {
  estado.proyecto = { id: 'p-tesista', universidad: 'Universidad Señor de Sipán', carrera: 'Enfermería' };
  const archivo = docx('del tesista');

  const id = await formatoService.proponerDesdeTesista({ userId: 'u2', productCode: 'METODO', buffer: archivo, nombre: 'Formato USS.docx' });
  const encolada = estado.filas.get(id);
  assert.equal(encolada.aprobado, false);
  assert.equal(encolada.universidad, 'Universidad Señor de Sipán');
  assert.equal(encolada.origenProjectId, 'p-tesista');
  assert.ok(fs.existsSync(path.join(temporal, 'formatos-universidad', `${id}.docx`)));

  // El mismo archivo otra vez: no se repite.
  assert.equal(await formatoService.proponerDesdeTesista({ userId: 'u2', productCode: 'METODO', buffer: archivo, nombre: 'x' }), null);
  // Otro del mismo tesista: sustituye al suyo sin revisar.
  const otro = await formatoService.proponerDesdeTesista({ userId: 'u2', productCode: 'METODO', buffer: docx('otro'), nombre: 'y' });
  assert.equal(estado.filas.has(id), false);
  assert.ok(estado.filas.has(otro));
  // Informe y artículo no entran.
  assert.equal(await formatoService.proponerDesdeTesista({ userId: 'u2', productCode: 'INFORME_X', buffer: docx('inf'), nombre: 'z' }), null);
  assert.equal(await formatoService.proponerDesdeTesista({ userId: 'u2', productCode: 'ARTICULO_X', buffer: docx('art'), nombre: 'z' }), null);
  await formatoService.borrar(otro);
});

test('la universidad se guarda en su proyecto solo si no tenía', async () => {
  estado.proyecto = { id: 'p3', universidad: null };
  await formatoService.recordarUniversidad('u', 'METODO', '  UCV  ');
  assert.equal(estado.proyecto.universidad, 'UCV');
  await formatoService.recordarUniversidad('u', 'METODO', 'Otra');
  assert.equal(estado.proyecto.universidad, 'UCV');
});

test.after(() => fs.rmSync(temporal, { recursive: true, force: true }));

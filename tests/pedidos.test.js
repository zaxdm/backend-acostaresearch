'use strict';

/**
 * Los encargos de revisión.
 *
 * Lo que se prueba: que solo entra un .docx de verdad y que al Word antiguo se
 * le dice qué hacer, que el enlace de los asesores NO abre el formulario de los
 * tesistas, que el seguimiento no revela quién está revisando ni las notas
 * internas, que asignar un asesor aprobado pone el pedido en revisión, que no
 * se puede entregar sin el documento de observaciones, y que el aviso al móvil
 * no lleva datos personales. La base, el aviso y las rutas de disco se
 * sustituyen; el archivo se escribe de verdad en una carpeta temporal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const CARPETA = fs.mkdtempSync(path.join(os.tmpdir(), 'pedidos-'));

sustituir('../src/config/env', {
  APP_URL: 'https://acostaresearch.com',
  pedidosDir: CARPETA,
  PEDIDO_MAX_BYTES: 25 * 1024 * 1024,
});

const estado = { convocatorias: new Map(), pedidos: new Map(), asesores: new Map(), avisos: [] };

const choqueDeUnico = () => Object.assign(new Error('Unique constraint'), { code: 'P2002' });

sustituir('../src/lib/prisma', {
  convocatoria: {
    create: async ({ data }) => {
      const fila = {
        id: `c-${estado.convocatorias.size + 1}`,
        intro: '',
        abierta: true,
        publica: false,
        createdAt: new Date(),
        ...data,
      };
      estado.convocatorias.set(fila.id, fila);
      return { ...fila };
    },
    findUnique: async ({ where }) => {
      const fila = where.id
        ? estado.convocatorias.get(where.id)
        : [...estado.convocatorias.values()].find((c) => c.slug === where.slug);
      return fila ? { ...fila } : null;
    },
    findFirst: async ({ where }) => {
      const fila = [...estado.convocatorias.values()]
        .reverse()
        .find((c) => c.tipo === where.tipo && c.publica && c.abierta);
      return fila ? { ...fila } : null;
    },
    findMany: async ({ where }) =>
      [...estado.convocatorias.values()]
        .reverse()
        .filter((c) => c.tipo === where.tipo)
        .map((c) => ({ ...c })),
    update: async ({ where, data }) => {
      const fila = estado.convocatorias.get(where.id);
      Object.assign(fila, data);
      return { ...fila };
    },
  },
  asesor: {
    findUnique: async ({ where }) => {
      const fila = estado.asesores.get(where.id);
      return fila ? { ...fila } : null;
    },
  },
  pedido: {
    create: async ({ data }) => {
      const repetido = [...estado.pedidos.values()].some((p) => p.codigo === data.codigo);
      if (repetido) throw choqueDeUnico();
      const fila = {
        id: `p-${estado.pedidos.size + 1}`,
        estado: 'RECIBIDO',
        asesorId: null,
        asesor: null,
        enlaceObservaciones: '',
        notas: null,
        asignadoAt: null,
        entregadoAt: null,
        createdAt: new Date(),
        ...data,
      };
      estado.pedidos.set(fila.id, fila);
      return { ...fila };
    },
    findUnique: async ({ where }) => {
      const fila = where.id
        ? estado.pedidos.get(where.id)
        : [...estado.pedidos.values()].find((p) => p.codigo === where.codigo);
      return fila ? { ...fila } : null;
    },
    findMany: async () => [...estado.pedidos.values()].reverse().map((p) => ({ ...p })),
    update: async ({ where, data }) => {
      const fila = estado.pedidos.get(where.id);
      for (const [clave, valor] of Object.entries(data)) {
        if (valor !== undefined) fila[clave] = valor;
      }
      fila.asesor = fila.asesorId ? estado.asesores.get(fila.asesorId) : null;
      return { ...fila };
    },
    delete: async ({ where }) => {
      estado.pedidos.delete(where.id);
      return {};
    },
  },
});

sustituir('../src/lib/notify', { avisarAlAdmin: (aviso) => estado.avisos.push(aviso) });

const puerta = require('../src/modules/convocatorias/convocatoria.service');
const pedidoService = require('../src/modules/pedidos/pedido.service');
const { pedidoQuerySchema } = require('../src/modules/pedidos/pedido.schema');

/** Un .docx es un zip: empieza por PK. */
const DOCX = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(64, 7)]);
/** Word 97, que es otra cosa y merece otro mensaje. */
const DOC_ANTIGUO = Buffer.concat([Buffer.from('d0cf11e0', 'hex'), Buffer.alloc(64, 7)]);

function empezar() {
  estado.convocatorias.clear();
  estado.pedidos.clear();
  estado.asesores.clear();
  estado.avisos.length = 0;
}

const datosValidos = (cambios = {}) => ({
  nombre: 'Luis Ramírez Chávez',
  email: 'Luis@Correo.com',
  telefono: '987654321',
  universidad: 'Universidad César Vallejo',
  nivel: 'MAESTRIA',
  area: 'EDUCACION',
  metodo: 'CUANTITATIVO',
  capitulo: 'CAP3',
  tema: 'Liderazgo directivo y clima escolar en instituciones públicas',
  mensaje: 'Mi asesor dice que la muestra no se justifica.',
  ...cambios,
});

const validar = (cambios) => {
  const salida = pedidoQuerySchema.safeParse(datosValidos(cambios));
  assert.equal(salida.success, true, salida.error && JSON.stringify(salida.error.issues));
  return salida.data;
};

/** Una puerta de revisión abierta, lista para recibir. */
const abrirPuerta = () => puerta.crear('REVISION', { nombre: 'Piloto' }, 'admin-1');

const aprobado = (id = 'a-1') => {
  estado.asesores.set(id, { id, nombre: 'Rosa Quispe', estado: 'APROBADO' });
  return id;
};

// ── El documento ────────────────────────────────────────────────────────────

test('al Word antiguo se le dice qué hacer, no solo que no vale', async () => {
  empezar();
  const { slug } = await abrirPuerta();
  await assert.rejects(
    () => pedidoService.crear(slug, validar(), DOC_ANTIGUO, 'tesis.doc'),
    /gu[áa]rdalo como \.docx/i,
  );
});

test('lo que no es un .docx no se guarda', async () => {
  empezar();
  const { slug } = await abrirPuerta();

  await assert.rejects(
    () => pedidoService.crear(slug, validar(), Buffer.from('%PDF-1.7'), 'tesis.pdf'),
    /no es un documento de Word/i,
  );
  // Zip de verdad pero con otro nombre: tampoco.
  await assert.rejects(
    () => pedidoService.crear(slug, validar(), DOCX, 'tesis.zip'),
    /Word \(\.docx\)/i,
  );
  await assert.rejects(() => pedidoService.crear(slug, validar(), Buffer.alloc(0), 'x.docx'), /Falta el documento/i);
});

// ── La puerta ───────────────────────────────────────────────────────────────

test('el enlace de los asesores no abre el formulario de los tesistas', async () => {
  empezar();
  const deAsesores = await puerta.crear('ASESORES', { nombre: 'Asesores' }, 'admin-1');

  await assert.rejects(() => pedidoService.verConvocatoria(deAsesores.slug), /no existe/i);
  await assert.rejects(
    () => pedidoService.crear(deAsesores.slug, validar(), DOCX, 'tesis.docx'),
    /no existe/i,
  );
});

test('mientras no haya una pública, /revision no encuentra nada', async () => {
  empezar();
  await abrirPuerta();
  assert.equal(await pedidoService.convocatoriaPublica(), null);

  const otra = await abrirPuerta();
  await puerta.cambiar(otra.id, { publica: true });
  const publica = await pedidoService.convocatoriaPublica();
  assert.equal(publica.slug, otra.slug);
  assert.ok(publica.catalogos.capitulos.length >= 5);
});

test('cerrada, el enlace abre pero ya no recibe', async () => {
  empezar();
  const convocatoria = await abrirPuerta();
  await puerta.cambiar(convocatoria.id, { abierta: false });

  const vista = await pedidoService.verConvocatoria(convocatoria.slug);
  assert.equal(vista.abierta, false);
  await assert.rejects(
    () => pedidoService.crear(convocatoria.slug, validar(), DOCX, 'tesis.docx'),
    /no estamos recibiendo/i,
  );
});

// ── El pedido ───────────────────────────────────────────────────────────────

test('el pedido nace recibido, con su código, y el archivo queda en disco', async () => {
  empezar();
  const { slug } = await abrirPuerta();
  const pedido = await pedidoService.crear(slug, validar(), DOCX, 'Tesis avance.docx');

  assert.equal(pedido.estado, 'RECIBIDO');
  assert.match(pedido.codigo, /^[a-z0-9]{8}$/);
  assert.equal(pedido.email, 'luis@correo.com');
  assert.equal(pedido.capituloNombre, 'Capítulo III — Metodología');
  assert.equal(pedido.bytes, DOCX.length);
  assert.ok(fs.existsSync(path.join(CARPETA, `${pedido.id}.docx`)), 'el .docx tiene que estar en disco');
});

test('el aviso al móvil no lleva el correo ni el nombre del tesista', async () => {
  empezar();
  const { slug } = await abrirPuerta();
  const pedido = await pedidoService.crear(slug, validar(), DOCX, 'tesis.docx');

  assert.equal(estado.avisos.length, 1);
  const aviso = JSON.stringify(estado.avisos[0]);
  assert.ok(!aviso.includes('luis@correo.com'), 'el aviso no debe llevar el correo');
  assert.ok(!aviso.includes('Ramírez'), 'el aviso no debe llevar el nombre');
  assert.ok(aviso.includes(pedido.codigo), 'el aviso sí lleva el código');
});

test('el seguimiento no dice quién revisa ni enseña las notas internas', async () => {
  empezar();
  const { slug } = await abrirPuerta();
  const pedido = await pedidoService.crear(slug, validar(), DOCX, 'tesis.docx');
  await pedidoService.cambiar(pedido.id, {
    asesorId: aprobado(),
    notas: 'Ojo: la matriz no cuadra con el instrumento.',
  });

  const visto = await pedidoService.seguimiento(pedido.codigo);
  const texto = JSON.stringify(visto);
  assert.ok(!texto.includes('Rosa Quispe'), 'no se revela el asesor');
  assert.ok(!texto.includes('la matriz no cuadra'), 'no se revelan las notas');
  assert.equal(visto.estado, 'EN_REVISION');
});

test('el enlace de observaciones solo se ve cuando está entregado', async () => {
  empezar();
  const { slug } = await abrirPuerta();
  const pedido = await pedidoService.crear(slug, validar(), DOCX, 'tesis.docx');

  await pedidoService.cambiar(pedido.id, { enlaceObservaciones: 'https://docs.google.com/abc' });
  assert.equal((await pedidoService.seguimiento(pedido.codigo)).enlaceObservaciones, '');

  await pedidoService.cambiar(pedido.id, { estado: 'ENTREGADO' });
  const entregado = await pedidoService.seguimiento(pedido.codigo);
  assert.equal(entregado.enlaceObservaciones, 'https://docs.google.com/abc');
  assert.ok(entregado.entregadoAt instanceof Date);
});

test('no se entrega un pedido sin el documento de observaciones', async () => {
  empezar();
  const { slug } = await abrirPuerta();
  const pedido = await pedidoService.crear(slug, validar(), DOCX, 'tesis.docx');

  await assert.rejects(
    () => pedidoService.cambiar(pedido.id, { estado: 'ENTREGADO' }),
    /sin el documento de observaciones/i,
  );
});

test('asignar a un asesor aprobado lo pone en revisión y sella la fecha', async () => {
  empezar();
  const { slug } = await abrirPuerta();
  const pedido = await pedidoService.crear(slug, validar(), DOCX, 'tesis.docx');

  const asignado = await pedidoService.cambiar(pedido.id, { asesorId: aprobado() });
  assert.equal(asignado.estado, 'EN_REVISION');
  assert.ok(asignado.asignadoAt instanceof Date);
  assert.equal(asignado.asesor.nombre, 'Rosa Quispe');
});

test('a un asesor sin aprobar no se le asigna nada', async () => {
  empezar();
  const { slug } = await abrirPuerta();
  const pedido = await pedidoService.crear(slug, validar(), DOCX, 'tesis.docx');
  estado.asesores.set('a-9', { id: 'a-9', nombre: 'Sin comprobar', estado: 'PENDIENTE' });

  await assert.rejects(
    () => pedidoService.cambiar(pedido.id, { asesorId: 'a-9' }),
    /todav[íi]a no est[áa] aprobado/i,
  );
});

test('un pedido cancelado deja de existir para su código', async () => {
  empezar();
  const { slug } = await abrirPuerta();
  const pedido = await pedidoService.crear(slug, validar(), DOCX, 'tesis.docx');
  await pedidoService.cambiar(pedido.id, { estado: 'CANCELADO' });

  await assert.rejects(() => pedidoService.seguimiento(pedido.codigo), /No encontramos/i);
});

// ── El formulario ───────────────────────────────────────────────────────────

test('el formulario exige tema, universidad y los tres códigos del catálogo', () => {
  for (const cambio of [
    { tema: 'corto' },
    { universidad: '' },
    { area: 'DERECHO' },
    { metodo: 'ADIVINANZA' },
    { capitulo: 'CAP9' },
    { nivel: 'TECNICO' },
    { email: 'no-es-correo' },
  ]) {
    const salida = pedidoQuerySchema.safeParse(datosValidos(cambio));
    assert.equal(salida.success, false, `debería rechazar ${JSON.stringify(cambio)}`);
  }
});

test('lo que quiera que se mire con cuidado es opcional', () => {
  assert.equal(validar({ mensaje: '' }).mensaje, '');
});

test.after(() => fs.rmSync(CARPETA, { recursive: true, force: true }));

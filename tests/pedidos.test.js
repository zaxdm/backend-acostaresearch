'use strict';

/**
 * Los encargos de revisión, con el flujo nuevo: el tesista elige a su asesor y
 * el encargo le llega directo, sin que nadie de la casa lo reparta.
 *
 * Lo que se prueba, por orden de importancia:
 *
 *  1. QUE NADIE LEA UNA TESIS SIN COMPROMETERSE. Mientras el encargo espera
 *     respuesta, el asesor no ve el documento ni el contacto del tesista, y el
 *     servidor se niega a servir el archivo aunque se adivine la dirección.
 *  2. Que el enlace de un asesor no abra los encargos de otro.
 *  3. Que solo se pueda elegir a quien está aprobado y aceptando encargos.
 *  4. Que un rechazo no obligue al tesista a empezar de cero.
 *  5. Que no se entregue sin el documento de observaciones, y que la nota solo
 *     se pueda poner una vez y solo si hubo entrega.
 *
 * La base, el aviso y las rutas de disco se sustituyen; el archivo se escribe
 * de verdad en una carpeta temporal.
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

/**
 * Identificadores con forma de UUID.
 *
 * El formulario exige que el asesor elegido lo sea —un pedido sin destinatario
 * no existe—, así que un doble que aceptara «a-1» probaría algo que el servidor
 * de verdad rechaza.
 */
const ID = {
  uno: '11111111-1111-4111-8111-111111111111',
  dos: '22222222-2222-4222-8222-222222222222',
  pendiente: '33333333-3333-4333-8333-333333333333',
  lleno: '44444444-4444-4444-8444-444444444444',
  oculto: '55555555-5555-4555-8555-555555555555',
  nuevo: '66666666-6666-4666-8666-666666666666',
};

const CARPETA = fs.mkdtempSync(path.join(os.tmpdir(), 'pedidos-'));

/**
 * El entorno de las pruebas.
 *
 * Se guarda la referencia para poder mover `AVISOS_REVISION` a mitad de una
 * prueba: el interruptor se lee cada vez que se avisa, no al cargar, y eso es
 * justo lo que hay que comprobar.
 */
const ENTORNO = {
  APP_URL: 'https://acostaresearch.com',
  pedidosDir: CARPETA,
  PEDIDO_MAX_BYTES: 25 * 1024 * 1024,
  BETA_REVISION_EMAILS: 'Zix@Gmail.com, otra@correo.com',
  AVISOS_REVISION: true,
};

sustituir('../src/config/env', ENTORNO);

const estado = {
  convocatorias: new Map(),
  pedidos: new Map(),
  asesores: new Map(),
  resenas: new Map(),
  mensajes: new Map(),
  avisos: [],
};

const choqueDeUnico = () => Object.assign(new Error('Unique constraint'), { code: 'P2002' });

/** El pedido con su asesor y su reseña ya pegados, como lo devuelve Prisma. */
function conRelaciones(fila) {
  if (!fila) return null;
  const asesor = fila.asesorId ? estado.asesores.get(fila.asesorId) : null;
  const resena = [...estado.resenas.values()].find((r) => r.pedidoId === fila.id) ?? null;
  return { ...fila, asesor: asesor ? { ...asesor } : null, resena: resena ? { ...resena } : null };
}

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
      [...estado.convocatorias.values()].reverse().filter((c) => c.tipo === where.tipo),
    update: async ({ where, data }) => {
      const fila = estado.convocatorias.get(where.id);
      Object.assign(fila, data);
      return { ...fila };
    },
  },
  asesor: {
    findUnique: async ({ where }) => {
      const fila = where.id
        ? estado.asesores.get(where.id)
        : [...estado.asesores.values()].find((a) => a.token === where.token);
      return fila ? { ...fila } : null;
    },
    findMany: async ({ where }) =>
      [...estado.asesores.values()].filter(
        (a) => a.estado === where.estado && a.visible === where.visible,
      ),
    update: async ({ where, data }) => {
      const fila = estado.asesores.get(where.id);
      Object.assign(fila, data);
      return { ...fila };
    },
  },
  pedido: {
    create: async ({ data }) => {
      if ([...estado.pedidos.values()].some((p) => p.codigo === data.codigo)) throw choqueDeUnico();
      const fila = {
        id: `p-${estado.pedidos.size + 1}`,
        estado: 'ESPERANDO',
        asesorId: null,
        enlaceObservaciones: '',
        motivoRechazo: '',
        notas: null,
        asignadoAt: null,
        aceptadoAt: null,
        entregadoAt: null,
        createdAt: new Date(),
        ...data,
      };
      estado.pedidos.set(fila.id, fila);
      return conRelaciones(fila);
    },
    findUnique: async ({ where }) => {
      const fila = where.id
        ? estado.pedidos.get(where.id)
        : [...estado.pedidos.values()].find((p) => p.codigo === where.codigo);
      return conRelaciones(fila);
    },
    findMany: async ({ where }) =>
      [...estado.pedidos.values()]
        .filter((p) => (where?.asesorId ? p.asesorId === where.asesorId : true))
        .filter((p) => (where?.email ? p.email === where.email : true))
        .filter((p) => (where?.estado?.not ? p.estado !== where.estado.not : true))
        .reverse()
        .map(conRelaciones),
    groupBy: async ({ where }) => {
      const cuenta = new Map();
      for (const fila of estado.pedidos.values()) {
        if (fila.estado !== where.estado) continue;
        if (!where.asesorId.in.includes(fila.asesorId)) continue;
        cuenta.set(fila.asesorId, (cuenta.get(fila.asesorId) ?? 0) + 1);
      }
      return [...cuenta].map(([asesorId, total]) => ({ asesorId, _count: { _all: total } }));
    },
    update: async ({ where, data }) => {
      const fila = estado.pedidos.get(where.id);
      for (const [clave, valor] of Object.entries(data)) {
        if (valor !== undefined) fila[clave] = valor;
      }
      return conRelaciones(fila);
    },
    delete: async ({ where }) => {
      estado.pedidos.delete(where.id);
      return {};
    },
  },
  mensaje: {
    create: async ({ data }) => {
      const fila = {
        id: `m-${estado.mensajes.size + 1}`,
        archivoNombre: '',
        bytes: 0,
        leidoAt: null,
        createdAt: new Date(),
        ...data,
      };
      estado.mensajes.set(fila.id, fila);
      return { ...fila };
    },
    findUnique: async ({ where }) => {
      const fila = estado.mensajes.get(where.id);
      return fila ? { ...fila } : null;
    },
    findMany: async ({ where }) =>
      [...estado.mensajes.values()].filter((m) => m.pedidoId === where.pedidoId),
    updateMany: async ({ where, data }) => {
      let tocados = 0;
      for (const fila of estado.mensajes.values()) {
        if (fila.pedidoId !== where.pedidoId || fila.de !== where.de) continue;
        if (where.leidoAt === null && fila.leidoAt !== null) continue;
        Object.assign(fila, data);
        tocados += 1;
      }
      return { count: tocados };
    },
    groupBy: async ({ where }) => {
      const cuenta = new Map();
      for (const fila of estado.mensajes.values()) {
        if (!where.pedidoId.in.includes(fila.pedidoId)) continue;
        if (fila.de !== where.de || fila.leidoAt !== null) continue;
        cuenta.set(fila.pedidoId, (cuenta.get(fila.pedidoId) ?? 0) + 1);
      }
      return [...cuenta].map(([pedidoId, total]) => ({ pedidoId, _count: { _all: total } }));
    },
    delete: async ({ where }) => {
      estado.mensajes.delete(where.id);
      return {};
    },
  },
  resena: {
    create: async ({ data }) => {
      if ([...estado.resenas.values()].some((r) => r.pedidoId === data.pedidoId)) {
        throw choqueDeUnico();
      }
      const fila = { id: `r-${estado.resenas.size + 1}`, createdAt: new Date(), ...data };
      estado.resenas.set(fila.id, fila);
      return { ...fila };
    },
    groupBy: async ({ where }) => {
      const porAsesor = new Map();
      for (const fila of estado.resenas.values()) {
        if (!where.asesorId.in.includes(fila.asesorId)) continue;
        const actual = porAsesor.get(fila.asesorId) ?? { total: 0, suma: 0 };
        actual.total += 1;
        actual.suma += fila.estrellas;
        porAsesor.set(fila.asesorId, actual);
      }
      return [...porAsesor].map(([asesorId, { total, suma }]) => ({
        asesorId,
        _count: { _all: total },
        _avg: { estrellas: suma / total },
      }));
    },
    findMany: async ({ where }) =>
      [...estado.resenas.values()].filter(
        (r) => where.asesorId.in.includes(r.asesorId) && r.comentario !== '',
      ),
  },
});

sustituir('../src/lib/notify', { avisarAlAdmin: (aviso) => estado.avisos.push(aviso) });

// El log se calla: lo monta pino con el entorno de verdad, y aquí el entorno
// está sustituido por el de arriba, que solo trae lo que estas pruebas usan.
sustituir('../src/config/logger', {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
});

const puerta = require('../src/modules/convocatorias/convocatoria.service');
const conversacion = require('../src/modules/pedidos/conversacion.service');
const { enBeta } = require('../src/modules/pedidos/beta');
const pedidoService = require('../src/modules/pedidos/pedido.service');
const { pedidoQuerySchema } = require('../src/modules/pedidos/pedido.schema');

/** Un .docx es un zip: empieza por PK. */
const DOCX = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(64, 7)]);
/** Word 97, que es otra cosa y merece otro mensaje. */
const DOC_ANTIGUO = Buffer.concat([Buffer.from('d0cf11e0', 'hex'), Buffer.alloc(64, 7)]);

function empezar() {
  ENTORNO.AVISOS_REVISION = true;
  estado.convocatorias.clear();
  estado.pedidos.clear();
  estado.asesores.clear();
  estado.resenas.clear();
  estado.mensajes.clear();
  estado.avisos.length = 0;
}

/** Un asesor en el directorio, listo para recibir encargos. */
function asesorEn(id, cambios = {}) {
  const fila = {
    id,
    nombre: 'Rosa Quispe Mamani',
    estado: 'APROBADO',
    visible: true,
    token: `tok${id.replace(/-/g, '').slice(0, 24)}`,
    grado: 'MAGISTER',
    especialidad: 'Gestión educativa',
    areas: 'EDUCACION, SALUD',
    metodos: 'CUANTITATIVO',
    universidades: 'UCV, UNT',
    anosExperiencia: 6,
    presentacion: 'Seis años asesorando tesis de maestría.',
    createdAt: new Date(),
    ...cambios,
  };
  estado.asesores.set(id, fila);
  return fila;
}

const abrirPuerta = () => puerta.crear('REVISION', { nombre: 'Piloto' }, 'admin-1');

const datosValidos = (cambios = {}) => ({
  asesorId: '11111111-1111-4111-8111-111111111111',
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

/** Puerta abierta, un asesor dentro y un encargo suyo esperando respuesta. */
async function conEncargo(idAsesor = ID.uno) {
  empezar();
  const { slug } = await abrirPuerta();
  const asesor = asesorEn(idAsesor);
  const pedido = await pedidoService.crear(
    slug,
    validar({ asesorId: asesor.id }),
    DOCX,
    'tesis.docx',
  );
  return { slug, asesor, pedido };
}

// ── Lo que no puede leer quien no se comprometió ───────────────────────────

test('mientras espera respuesta, el asesor no ve el documento ni al tesista', async () => {
  const { asesor } = await conEncargo();

  const { encargos } = await pedidoService.panelDelAsesor(asesor.token);
  assert.equal(encargos.length, 1);
  assert.equal(encargos[0].estado, 'ESPERANDO');
  assert.equal(encargos[0].archivoNombre, '', 'no se enseña el nombre del archivo');
  assert.equal(encargos[0].tesista, null, 'no se enseña el contacto del tesista');
  // Pero sí lo que hace falta para decidir.
  assert.equal(encargos[0].capitulo, 'Capítulo III — Metodología');
  assert.ok(encargos[0].tema.includes('Liderazgo'));
  assert.ok(encargos[0].mensaje.includes('la muestra'));
});

test('y el servidor le niega el archivo aunque adivine la dirección', async () => {
  const { asesor, pedido } = await conEncargo();

  await assert.rejects(
    () => pedidoService.documentoParaAsesor(asesor.token, pedido.id),
    /Acepta el encargo/i,
  );

  await pedidoService.aceptar(asesor.token, pedido.id);
  const archivo = await pedidoService.documentoParaAsesor(asesor.token, pedido.id);
  assert.ok(archivo.ruta.endsWith(`${pedido.id}.docx`));
});

test('el enlace de un asesor no abre los encargos de otro', async () => {
  const { pedido } = await conEncargo();
  const otro = asesorEn(ID.dos, { nombre: 'Otro Asesor', token: 'tokotro000000000000' });

  await assert.rejects(() => pedidoService.aceptar(otro.token, pedido.id), /no es tuyo/i);
  await assert.rejects(
    () => pedidoService.documentoParaAsesor(otro.token, pedido.id),
    /no es tuyo/i,
  );
  const { encargos } = await pedidoService.panelDelAsesor(otro.token);
  assert.equal(encargos.length, 0);
});

test('un token que no existe no enseña nada', async () => {
  empezar();
  await assert.rejects(() => pedidoService.panelDelAsesor('tokinventado00000000'), /no existe/i);
});

// ── A quién se puede elegir ────────────────────────────────────────────────

test('solo se elige a quien está aprobado y aceptando encargos', async () => {
  empezar();
  const { slug } = await abrirPuerta();
  asesorEn(ID.pendiente, { estado: 'PENDIENTE', token: 'tokpend0000000000000' });
  asesorEn(ID.lleno, { visible: false, nombre: 'Ana Lima', token: 'toklleno000000000000' });

  await assert.rejects(
    () => pedidoService.crear(slug, validar({ asesorId: ID.pendiente }), DOCX, 'tesis.docx'),
    /ya no está disponible/i,
  );
  await assert.rejects(
    () => pedidoService.crear(slug, validar({ asesorId: ID.lleno }), DOCX, 'tesis.docx'),
    /no está aceptando encargos/i,
  );
});

test('el directorio solo trae a los aprobados y visibles, sin datos de contacto', async () => {
  empezar();
  const { slug } = await abrirPuerta();
  asesorEn(ID.uno, { email: 'rosa@correo.com', numeroDocumento: '45678912' });
  asesorEn(ID.oculto, { visible: false, token: 'tokocul0000000000000' });
  asesorEn(ID.nuevo, { estado: 'PENDIENTE', token: 'toknuev0000000000000' });

  const directorio = await pedidoService.directorio(slug);
  assert.equal(directorio.length, 1);

  const ficha = directorio[0];
  assert.equal(ficha.iniciales, 'RM');
  assert.equal(ficha.gradoNombre, 'Magíster');
  assert.deepEqual(ficha.areas, ['Educación', 'Salud']);
  const texto = JSON.stringify(ficha);
  assert.ok(!texto.includes('rosa@correo.com'), 'el directorio no lleva el correo');
  assert.ok(!texto.includes('45678912'), 'ni el documento');
});

test('el asesor puede apagarse cuando está lleno', async () => {
  const { asesor, slug } = await conEncargo();

  const panel = await pedidoService.cambiarDisponibilidad(asesor.token, false);
  assert.equal(panel.asesor.visible, false);
  assert.equal((await pedidoService.directorio(slug)).length, 0);
});

// ── Aceptar, rechazar, entregar ────────────────────────────────────────────

test('aceptar sella la fecha y abre el documento', async () => {
  const { asesor, pedido } = await conEncargo();

  const aceptado = await pedidoService.aceptar(asesor.token, pedido.id);
  assert.equal(aceptado.estado, 'EN_REVISION');
  assert.ok(aceptado.aceptadoAt instanceof Date);
  assert.equal(aceptado.archivoNombre, 'tesis.docx');
  assert.equal(aceptado.tesista.email, 'luis@correo.com');

  // Y no se acepta dos veces.
  await assert.rejects(() => pedidoService.aceptar(asesor.token, pedido.id), /ya no está esperando/i);
});

test('rechazar guarda el motivo y el tesista lo lee', async () => {
  const { asesor, pedido } = await conEncargo();
  await pedidoService.rechazar(asesor.token, pedido.id, 'Este mes no tengo hueco.');

  const visto = await pedidoService.seguimiento(pedido.codigo);
  assert.equal(visto.estado, 'RECHAZADO');
  assert.equal(visto.motivoRechazo, 'Este mes no tengo hueco.');
});

test('tras un rechazo elige otro asesor sin volver a subir nada', async () => {
  const { asesor, pedido } = await conEncargo();
  await pedidoService.rechazar(asesor.token, pedido.id, 'No es mi especialidad.');
  const otro = asesorEn(ID.dos, { nombre: 'Ana Lima Soto', token: 'tokotro000000000000' });

  const guardado = await pedidoService.reasignar(pedido.codigo, otro.id);
  assert.equal(guardado.estado, 'ESPERANDO');
  assert.equal(guardado.motivoRechazo, '');
  assert.equal(guardado.asesor.nombre, 'Ana Lima Soto');
  // El documento sigue donde estaba: no se volvió a subir nada.
  assert.ok(fs.existsSync(path.join(CARPETA, `${pedido.id}.docx`)));
});

test('no se cambia de asesor si el encargo va en marcha, ni se repite el mismo', async () => {
  const { asesor, pedido } = await conEncargo();
  asesorEn(ID.dos, { token: 'tokotro000000000000' });

  await assert.rejects(() => pedidoService.reasignar(pedido.codigo, ID.dos), /ya está en marcha/i);

  await pedidoService.rechazar(asesor.token, pedido.id, 'No puedo.');
  await assert.rejects(() => pedidoService.reasignar(pedido.codigo, asesor.id), /no pudo tomarlo/i);
});

test('no se entrega sin el documento de observaciones', async () => {
  const { asesor, pedido } = await conEncargo();
  await pedidoService.aceptar(asesor.token, pedido.id);

  await assert.rejects(
    () => pedidoService.entregar(asesor.token, pedido.id, ''),
    /Pega el enlace/i,
  );
});

test('entregar deja el enlace a la vista del tesista, y antes no', async () => {
  const { asesor, pedido } = await conEncargo();
  await pedidoService.aceptar(asesor.token, pedido.id);

  assert.equal((await pedidoService.seguimiento(pedido.codigo)).enlaceObservaciones, '');

  await pedidoService.entregar(asesor.token, pedido.id, 'https://docs.google.com/abc');
  const visto = await pedidoService.seguimiento(pedido.codigo);
  assert.equal(visto.estado, 'ENTREGADO');
  assert.equal(visto.enlaceObservaciones, 'https://docs.google.com/abc');
  assert.equal(visto.puedeResenar, true);
});

test('solo se entrega lo que se está revisando', async () => {
  const { asesor, pedido } = await conEncargo();
  await assert.rejects(
    () => pedidoService.entregar(asesor.token, pedido.id, 'https://docs.google.com/abc'),
    /Solo se entrega/i,
  );
});

// ── La conversación ────────────────────────────────────────────────────────

test('no se puede hablar hasta que el asesor acepta', async () => {
  const { pedido } = await conEncargo();

  await assert.rejects(
    () => conversacion.comoTesista.escribir(pedido.codigo, { texto: '¿Lo viste?' }),
    /cuando el asesor acepta/i,
  );
  const vista = await conversacion.comoTesista.ver(pedido.codigo);
  assert.equal(vista.abierta, false);
  assert.equal(vista.mensajes.length, 0);
});

test('aceptar con saludo abre la conversación con su primer mensaje', async () => {
  const { asesor, pedido } = await conEncargo();
  await pedidoService.aceptar(asesor.token, pedido.id, 'Me lo quedo, te escribo el jueves.');

  const vista = await conversacion.comoTesista.ver(pedido.codigo);
  assert.equal(vista.abierta, true);
  assert.equal(vista.mensajes.length, 1);
  assert.equal(vista.mensajes[0].de, 'ASESOR');
  assert.match(vista.mensajes[0].texto, /te escribo el jueves/i);
});

test('y sin saludo se acepta igual, sin mensajes', async () => {
  const { asesor, pedido } = await conEncargo();
  await pedidoService.aceptar(asesor.token, pedido.id);
  assert.equal((await conversacion.comoTesista.ver(pedido.codigo)).mensajes.length, 0);
});

test('lo sin leer lo cuenta quien lo recibe, y se apaga al mirarlo', async () => {
  const { asesor, pedido } = await conEncargo();
  await pedidoService.aceptar(asesor.token, pedido.id);
  await conversacion.comoAsesor.escribir(asesor.token, pedido.id, { texto: 'Una duda del cap. III.' });

  // El tesista lo tiene sin leer, el asesor no: lo escribió él.
  assert.equal((await pedidoService.seguimiento(pedido.codigo)).sinLeer, 1);
  assert.equal((await pedidoService.panelDelAsesor(asesor.token)).encargos[0].sinLeer, 0);

  // Abrir la conversación es leerla.
  await conversacion.comoTesista.ver(pedido.codigo);
  assert.equal((await pedidoService.seguimiento(pedido.codigo)).sinLeer, 0);
});

test('el tesista adjunta su versión corregida y el asesor la puede bajar', async () => {
  const { asesor, pedido } = await conEncargo();
  await pedidoService.aceptar(asesor.token, pedido.id);
  await pedidoService.entregar(asesor.token, pedido.id, 'https://docs.google.com/abc');

  const mensaje = await conversacion.comoTesista.escribir(pedido.codigo, {
    texto: 'Ya levanté las observaciones 1 a 7.',
    archivo: DOCX,
    nombreArchivo: 'tesis-corregida.docx',
  });
  assert.equal(mensaje.archivoNombre, 'tesis-corregida.docx');
  assert.equal(mensaje.bytes, DOCX.length);

  // Después de entregar se sigue hablando: es cuando el tesista corrige.
  const archivo = await conversacion.comoAsesor.adjunto(asesor.token, pedido.id, mensaje.id);
  assert.ok(fs.existsSync(archivo.ruta));
});

test('lo adjuntado tiene que ser un .docx', async () => {
  const { asesor, pedido } = await conEncargo();
  await pedidoService.aceptar(asesor.token, pedido.id);

  await assert.rejects(
    () =>
      conversacion.comoTesista.escribir(pedido.codigo, {
        texto: 'Aquí va',
        archivo: Buffer.from('%PDF-1.7'),
        nombreArchivo: 'tesis.pdf',
      }),
    /no es un documento de Word/i,
  );
});

test('el asesor no lee la conversación de un encargo que no es suyo', async () => {
  const { asesor, pedido } = await conEncargo();
  await pedidoService.aceptar(asesor.token, pedido.id);
  const otro = asesorEn(ID.dos, { nombre: 'Otro Asesor', token: 'tokotro000000000000' });

  await assert.rejects(
    () => conversacion.comoAsesor.ver(otro.token, pedido.id),
    /no es tuyo/i,
  );
});

test('un código que no existe no abre ninguna conversación', async () => {
  empezar();
  await assert.rejects(() => conversacion.comoTesista.ver('noexiste'), /No encontramos/i);
});

// ── La nota ────────────────────────────────────────────────────────────────

/** Un encargo llevado hasta el final, listo para calificar. */
async function hastaEntregar(idAsesor = ID.uno) {
  const { asesor, pedido, slug } = await conEncargo(idAsesor);
  await pedidoService.aceptar(asesor.token, pedido.id);
  await pedidoService.entregar(asesor.token, pedido.id, 'https://docs.google.com/abc');
  return { asesor, pedido, slug };
}

test('no se califica antes de que entreguen, ni dos veces', async () => {
  const { asesor, pedido } = await conEncargo();
  await assert.rejects(
    () => pedidoService.resenar(pedido.codigo, { estrellas: 5, comentario: '' }),
    /cuando recibas tus observaciones/i,
  );

  await pedidoService.aceptar(asesor.token, pedido.id);
  await pedidoService.entregar(asesor.token, pedido.id, 'https://docs.google.com/abc');
  await pedidoService.resenar(pedido.codigo, { estrellas: 5, comentario: 'Clarísimo.' });

  await assert.rejects(
    () => pedidoService.resenar(pedido.codigo, { estrellas: 1, comentario: '' }),
    /Ya calificaste/i,
  );
});

test('la nota no se enseña hasta que hay tres reseñas', async () => {
  const { asesor, slug } = await hastaEntregar();

  await pedidoService.resenar((await pedidoService.listar())[0].codigo, { estrellas: 5, comentario: '' });
  let ficha = (await pedidoService.directorio(slug))[0];
  assert.equal(ficha.resenas, 1);
  assert.equal(ficha.nota, null, 'con una reseña no se enseña nota');
  assert.equal(ficha.tesisRevisadas, 1);

  // Dos encargos más, hasta entregar y calificar.
  for (const estrellas of [4, 3]) {
    const pedido = await pedidoService.crear(slug, validar({ asesorId: asesor.id }), DOCX, 'x.docx');
    await pedidoService.aceptar(asesor.token, pedido.id);
    await pedidoService.entregar(asesor.token, pedido.id, 'https://docs.google.com/abc');
    await pedidoService.resenar(pedido.codigo, { estrellas, comentario: 'Bien.' });
  }

  ficha = (await pedidoService.directorio(slug))[0];
  assert.equal(ficha.resenas, 3);
  assert.equal(ficha.nota, 4, 'con tres, la media: (5+4+3)/3');
  assert.equal(ficha.tesisRevisadas, 3);
  assert.equal(ficha.ultimasResenas.length, 2, 'solo las que traen comentario');
});

// ── El documento ───────────────────────────────────────────────────────────

test('al Word antiguo se le dice qué hacer, no solo que no vale', async () => {
  empezar();
  const { slug } = await abrirPuerta();
  asesorEn(ID.uno);
  await assert.rejects(
    () => pedidoService.crear(slug, validar({ asesorId: ID.uno }), DOC_ANTIGUO, 'tesis.doc'),
    /gu[áa]rdalo como \.docx/i,
  );
});

test('lo que no es un .docx no se guarda', async () => {
  empezar();
  const { slug } = await abrirPuerta();
  asesorEn(ID.uno);
  const datos = validar({ asesorId: ID.uno });

  await assert.rejects(
    () => pedidoService.crear(slug, datos, Buffer.from('%PDF-1.7'), 'tesis.pdf'),
    /no es un documento de Word/i,
  );
  await assert.rejects(() => pedidoService.crear(slug, datos, DOCX, 'tesis.zip'), /Word \(\.docx\)/i);
});

// ── La puerta ──────────────────────────────────────────────────────────────

test('el enlace de los asesores no abre el formulario de los tesistas', async () => {
  empezar();
  const deAsesores = await puerta.crear('ASESORES', { nombre: 'Asesores' }, 'admin-1');
  await assert.rejects(() => pedidoService.verConvocatoria(deAsesores.slug), /no existe/i);
  await assert.rejects(() => pedidoService.directorio(deAsesores.slug), /no existe/i);
});

test('mientras no haya una pública, /revision no encuentra nada', async () => {
  empezar();
  await abrirPuerta();
  assert.equal(await pedidoService.convocatoriaPublica(), null);
});

test('cerrada, el enlace abre pero ya no recibe', async () => {
  empezar();
  const convocatoria = await abrirPuerta();
  asesorEn(ID.uno);
  await puerta.cambiar(convocatoria.id, { abierta: false });

  assert.equal((await pedidoService.verConvocatoria(convocatoria.slug)).abierta, false);
  await assert.rejects(
    () => pedidoService.crear(convocatoria.slug, validar({ asesorId: ID.uno }), DOCX, 'tesis.docx'),
    /no estamos recibiendo/i,
  );
});

// ── El pedido y el aviso ───────────────────────────────────────────────────

test('el pedido nace esperando a su asesor, con su código y su archivo en disco', async () => {
  const { pedido } = await conEncargo();

  assert.equal(pedido.estado, 'ESPERANDO');
  assert.match(pedido.codigo, /^[a-z0-9]{8}$/);
  assert.equal(pedido.asesorId, ID.uno);
  assert.ok(pedido.asignadoAt instanceof Date);
  assert.ok(fs.existsSync(path.join(CARPETA, `${pedido.id}.docx`)));
});

test('el aviso al móvil no lleva el correo ni el nombre del tesista', async () => {
  const { pedido } = await conEncargo();

  const aviso = JSON.stringify(estado.avisos[0]);
  assert.ok(!aviso.includes('luis@correo.com'), 'sin el correo');
  assert.ok(!aviso.includes('Ramírez'), 'sin el nombre del tesista');
  assert.ok(aviso.includes(pedido.codigo), 'con el código');
});

test('con los avisos del piloto apagados no suena el móvil', async () => {
  empezar();
  ENTORNO.AVISOS_REVISION = false;

  const { slug } = await abrirPuerta();
  const asesor = asesorEn(ID.uno);
  const pedido = await pedidoService.crear(
    slug,
    validar({ asesorId: asesor.id }),
    DOCX,
    'tesis.docx',
  );
  await pedidoService.aceptar(asesor.token, pedido.id);
  await pedidoService.entregar(asesor.token, pedido.id, 'https://docs.google.com/abc');

  assert.equal(estado.avisos.length, 0, 'ni el encargo ni la entrega avisan');
  // Y el pedido existe igual: callar el aviso no puede cambiar lo que pasa.
  assert.equal((await pedidoService.seguimiento(pedido.codigo)).estado, 'ENTREGADO');
});

test('el seguimiento sí dice a quién está esperando, pero no las notas internas', async () => {
  const { pedido } = await conEncargo();
  await pedidoService.cambiar(pedido.id, { notas: 'Ojo con este.' });

  const visto = await pedidoService.seguimiento(pedido.codigo);
  assert.equal(visto.asesor.nombre, 'Rosa Quispe Mamani');
  assert.equal(visto.asesor.iniciales, 'RM');
  assert.ok(!JSON.stringify(visto).includes('Ojo con este'), 'las notas son de la casa');
});

test('un pedido cancelado deja de existir para su código', async () => {
  const { pedido } = await conEncargo();
  await pedidoService.cambiar(pedido.id, { estado: 'CANCELADO' });
  await assert.rejects(() => pedidoService.seguimiento(pedido.codigo), /No encontramos/i);
});

// ── Desde su panel ─────────────────────────────────────────────────────────

test('la lista de la prueba no distingue mayúsculas ni espacios', () => {
  assert.equal(enBeta('zix@gmail.com'), true);
  assert.equal(enBeta('  ZIX@GMAIL.COM  '), true);
  assert.equal(enBeta('cualquiera@correo.com'), false);
  assert.equal(enBeta(''), false);
  assert.equal(enBeta(null), false);
});

test('desde su panel se manda sin enlace de convocatoria', async () => {
  empezar();
  const asesor = asesorEn(ID.uno);

  const pedido = await pedidoService.crearDesdeSuPanel(
    validar({ asesorId: asesor.id }),
    DOCX,
    'tesis.docx',
  );
  assert.equal(pedido.estado, 'ESPERANDO');
  assert.equal(pedido.asesorId, asesor.id);
});

test('ve sus revisiones por su correo, y solo las suyas', async () => {
  empezar();
  const asesor = asesorEn(ID.uno);
  const mia = await pedidoService.crearDesdeSuPanel(
    validar({ asesorId: asesor.id, email: 'zix@gmail.com' }),
    DOCX,
    'tesis.docx',
  );
  await pedidoService.crearDesdeSuPanel(
    validar({ asesorId: asesor.id, email: 'otro@correo.com' }),
    DOCX,
    'otra.docx',
  );

  const suyas = await pedidoService.misPedidos('ZIX@GMAIL.COM');
  assert.equal(suyas.length, 1, 'el correo se compara en minúsculas');
  assert.equal(suyas[0].codigo, mia.codigo);
  // Y trae lo del seguimiento: a quién espera, sin las notas de la casa.
  assert.equal(suyas[0].asesor.nombre, 'Rosa Quispe Mamani');
});

test('un pedido cancelado desaparece también de su panel', async () => {
  empezar();
  const asesor = asesorEn(ID.uno);
  const pedido = await pedidoService.crearDesdeSuPanel(
    validar({ asesorId: asesor.id, email: 'zix@gmail.com' }),
    DOCX,
    'tesis.docx',
  );
  await pedidoService.cambiar(pedido.id, { estado: 'CANCELADO' });

  assert.equal((await pedidoService.misPedidos('zix@gmail.com')).length, 0);
});

// ── El formulario ──────────────────────────────────────────────────────────

test('sin asesor elegido el formulario no pasa', () => {
  const salida = pedidoQuerySchema.safeParse(datosValidos({ asesorId: '' }));
  assert.equal(salida.success, false);
  assert.ok(salida.error.issues.some((i) => i.path[0] === 'asesorId'));
});

test('el formulario exige tema, universidad y los códigos del catálogo', () => {
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

test.after(() => fs.rmSync(CARPETA, { recursive: true, force: true }));

'use strict';

/**
 * El registro de asesores.
 *
 * Lo que se prueba: que el formulario no deja pasar una ficha sin el sí a las
 * tres reglas, que toda ficha nace PENDIENTE, que una convocatoria cerrada
 * sigue abriendo su enlace pero ya no recibe, que mientras ninguna sea pública
 * /asesores no encuentra nada —que es lo que mantiene el piloto invisible—, y
 * que el aviso al móvil no lleva el correo ni el documento del candidato. La
 * base y los avisos se sustituyen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Los avisos del piloto nacen apagados —ver `modules/pedidos/beta`— y aquí se
// comprueba QUÉ lleva el aviso cuando sale. Que no salga se prueba en
// `pedidos.test.js`, que es donde vive el interruptor.
process.env.AVISOS_REVISION = 'true';

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const estado = { convocatorias: new Map(), asesores: new Map(), avisos: [] };

/** Un error de Prisma por índice único, tal como llega al servicio. */
const choqueDeUnico = () => Object.assign(new Error('Unique constraint'), { code: 'P2002' });

sustituir('../src/lib/prisma', {
  convocatoria: {
    // Los valores por defecto son los del esquema: sin ellos, una convocatoria
    // recién creada saldría sin `abierta` ni `publica` y la prueba mediría otra
    // cosa que la que mide la base de verdad.
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
        .find((c) => c.publica === where.publica && c.abierta === where.abierta);
      return fila ? { ...fila } : null;
    },
    findMany: async () => [...estado.convocatorias.values()].reverse().map((c) => ({ ...c })),
    update: async ({ where, data }) => {
      const fila = estado.convocatorias.get(where.id);
      Object.assign(fila, data);
      return { ...fila };
    },
  },
  asesor: {
    create: async ({ data }) => {
      const repetido = [...estado.asesores.values()].some((a) => a.email === data.email);
      if (repetido) throw choqueDeUnico();
      const fila = {
        id: `a-${estado.asesores.size + 1}`,
        estado: 'PENDIENTE',
        notas: null,
        revisadoAt: null,
        revisadoPorId: null,
        createdAt: new Date(),
        ...data,
      };
      estado.asesores.set(fila.id, fila);
      return { ...fila };
    },
    findUnique: async ({ where }) => {
      const fila = estado.asesores.get(where.id);
      return fila ? { ...fila } : null;
    },
    findMany: async () => [...estado.asesores.values()].reverse().map((a) => ({ ...a })),
    // `undefined` es «no toques este campo», como en Prisma. Con Object.assign
    // se escribiría undefined encima y una prueba como la del enlace que no se
    // rehace mediría lo contrario de lo que pasa en producción.
    update: async ({ where, data }) => {
      const fila = estado.asesores.get(where.id);
      for (const [clave, valor] of Object.entries(data)) {
        if (valor !== undefined) fila[clave] = valor;
      }
      return { ...fila };
    },
    groupBy: async () => {
      const cuenta = new Map();
      for (const fila of estado.asesores.values()) {
        const clave = `${fila.convocatoriaId}|${fila.estado}`;
        cuenta.set(clave, (cuenta.get(clave) ?? 0) + 1);
      }
      return [...cuenta.entries()].map(([clave, total]) => {
        const [convocatoriaId, estadoFila] = clave.split('|');
        return { convocatoriaId, estado: estadoFila, _count: { _all: total } };
      });
    },
  },
});

sustituir('../src/lib/notify', { avisarAlAdmin: (aviso) => estado.avisos.push(aviso) });

const { postulacionBodySchema } = require('../src/modules/asesores/asesor.schema');
const { guardarLista, AREAS } = require('../src/modules/asesores/asesor.catalogo');
const asesorService = require('../src/modules/asesores/asesor.service');

function empezar() {
  estado.convocatorias.clear();
  estado.asesores.clear();
  estado.avisos.length = 0;
}

const fichaValida = (cambios = {}) => ({
  nombre: 'Rosa Quispe Mamani',
  tipoDocumento: 'DNI',
  numeroDocumento: '45678912',
  email: 'Rosa@Correo.com',
  telefono: '+51 987 654 321',
  grado: 'MAGISTER',
  gradoUniversidad: 'Universidad Nacional de Trujillo',
  gradoAnio: '2019',
  registroSunedu: '',
  enlaceCv: '',
  areas: ['EDUCACION', 'SALUD'],
  metodos: ['CUANTITATIVO'],
  especialidad: 'Gestión educativa',
  universidades: 'UCV, UNT',
  anosExperiencia: 6,
  presentacion: 'He asesorado a más de treinta tesistas de maestría en educación en seis años.',
  aceptaReglas: true,
  ...cambios,
});

/** Lo que el servicio recibe: lo que el formulario dejó pasar, ya normalizado. */
const validar = (cambios) => {
  const salida = postulacionBodySchema.safeParse(fichaValida(cambios));
  assert.equal(salida.success, true, salida.error && JSON.stringify(salida.error.issues));
  return salida.data;
};

// ── El formulario ───────────────────────────────────────────────────────────

test('sin el sí a las tres reglas la ficha no pasa', () => {
  const salida = postulacionBodySchema.safeParse(fichaValida({ aceptaReglas: false }));
  assert.equal(salida.success, false);
  assert.ok(salida.error.issues.some((i) => i.path[0] === 'aceptaReglas'));
});

test('hace falta al menos un área y un enfoque', () => {
  const sinArea = postulacionBodySchema.safeParse(fichaValida({ areas: [] }));
  assert.equal(sinArea.success, false);
  const sinMetodo = postulacionBodySchema.safeParse(fichaValida({ metodos: [] }));
  assert.equal(sinMetodo.success, false);
});

test('el DNI de siete cifras no pasa, y el correo se guarda en minúsculas', () => {
  const corto = postulacionBodySchema.safeParse(fichaValida({ numeroDocumento: '4567891' }));
  assert.equal(corto.success, false);
  assert.equal(validar().email, 'rosa@correo.com');
});

test('un enlace que no es http no pasa; vacío sí', () => {
  const malo = postulacionBodySchema.safeParse(fichaValida({ enlaceCv: 'mi-cv.pdf' }));
  assert.equal(malo.success, false);
  assert.equal(validar({ enlaceCv: '' }).enlaceCv, '');
});

test('las áreas se guardan sin repetir y sin las que no existen', () => {
  assert.equal(guardarLista(['EDUCACION', 'EDUCACION', 'DERECHO'], AREAS), 'EDUCACION');
});

// ── La puerta ───────────────────────────────────────────────────────────────

test('una convocatoria nueva no es pública: solo se llega con el enlace', async () => {
  empezar();
  const convocatoria = await asesorService.crearConvocatoria({ nombre: 'Piloto' }, 'admin-1');

  assert.equal(convocatoria.publica, false);
  assert.equal(convocatoria.abierta, true);
  assert.equal(await asesorService.convocatoriaPublica(), null);

  // Con el slug sí se llega, y llega el catálogo para pintar el formulario.
  const vista = await asesorService.verConvocatoria(convocatoria.slug);
  assert.equal(vista.abierta, true);
  assert.ok(vista.catalogos.areas.length >= 3);
});

test('marcarla pública es lo único que hace falta para abrirla', async () => {
  empezar();
  const convocatoria = await asesorService.crearConvocatoria({ nombre: 'Piloto' }, 'admin-1');
  await asesorService.cambiarConvocatoria(convocatoria.id, { publica: true });

  const publica = await asesorService.convocatoriaPublica();
  assert.equal(publica.slug, convocatoria.slug);
});

test('cerrada, el enlace sigue abriendo pero ya no recibe fichas', async () => {
  empezar();
  const convocatoria = await asesorService.crearConvocatoria({ nombre: 'Piloto' }, 'admin-1');
  await asesorService.cambiarConvocatoria(convocatoria.id, { abierta: false });

  const vista = await asesorService.verConvocatoria(convocatoria.slug);
  assert.equal(vista.abierta, false);

  await assert.rejects(() => asesorService.postular(convocatoria.slug, validar()), /ya no recibe/i);
});

test('un slug que no existe no dice que exista', async () => {
  empezar();
  await assert.rejects(() => asesorService.verConvocatoria('noexiste1234'), /no existe/i);
});

// ── La ficha ────────────────────────────────────────────────────────────────

test('toda ficha nace pendiente, y el aviso no lleva correo ni documento', async () => {
  empezar();
  const convocatoria = await asesorService.crearConvocatoria({ nombre: 'Piloto' }, 'admin-1');
  const asesor = await asesorService.postular(convocatoria.slug, validar());

  assert.equal(asesor.estado, 'PENDIENTE');
  assert.equal(asesor.revisadoAt, null);
  // Los códigos vuelven traducidos, que es lo que lee el panel.
  assert.deepEqual(asesor.areas, ['Educación', 'Salud']);
  assert.equal(asesor.gradoNombre, 'Magíster');

  assert.equal(estado.avisos.length, 1);
  const aviso = JSON.stringify(estado.avisos[0]);
  assert.ok(!aviso.includes('rosa@correo.com'), 'el aviso no debe llevar el correo');
  assert.ok(!aviso.includes('45678912'), 'el aviso no debe llevar el documento');
  assert.ok(aviso.includes('Rosa'), 'el aviso sí lleva el nombre de pila');
});

test('el mismo correo no abre dos fichas', async () => {
  empezar();
  const convocatoria = await asesorService.crearConvocatoria({ nombre: 'Piloto' }, 'admin-1');
  await asesorService.postular(convocatoria.slug, validar());

  await assert.rejects(
    () => asesorService.postular(convocatoria.slug, validar({ nombre: 'Rosa Q. M.' })),
    /ya recibimos una ficha/i,
  );
});

test('aprobar sella la revisión y volver a pendiente la borra', async () => {
  empezar();
  const convocatoria = await asesorService.crearConvocatoria({ nombre: 'Piloto' }, 'admin-1');
  const ficha = await asesorService.postular(convocatoria.slug, validar());

  const aprobada = await asesorService.revisar(
    ficha.id,
    { estado: 'APROBADO', notas: 'Grado comprobado en SUNEDU.' },
    'admin-1',
  );
  assert.equal(aprobada.estado, 'APROBADO');
  assert.ok(aprobada.revisadoAt instanceof Date);
  assert.equal(aprobada.notas, 'Grado comprobado en SUNEDU.');

  const devuelta = await asesorService.revisar(ficha.id, { estado: 'PENDIENTE', notas: '' }, 'admin-1');
  assert.equal(devuelta.revisadoAt, null);
  assert.equal(devuelta.notas, null);
});

// ── El alta a mano ──────────────────────────────────────────────────────────

test('el alta desde el panel nace aprobada, con enlace y sin convocatoria', async () => {
  empezar();
  const asesor = await asesorService.darDeAlta(validar(), 'admin-1');

  assert.equal(asesor.estado, 'APROBADO');
  assert.equal(asesor.convocatoriaId, null, 'no vino por ninguna convocatoria');
  assert.equal(asesor.visible, true);
  assert.ok(asesor.revisadoAt instanceof Date);
  assert.match(asesor.token, /^[a-f0-9]{48}$/);
  assert.ok(asesor.enlacePanel.endsWith(`/asesor/${asesor.token}`));
});

test('dos altas con el mismo correo no pasan', async () => {
  empezar();
  await asesorService.darDeAlta(validar(), 'admin-1');
  await assert.rejects(
    () => asesorService.darDeAlta(validar({ nombre: 'Otra Persona' }), 'admin-1'),
    /ya hay una ficha con ese correo/i,
  );
});

test('editar la ficha cambia lo que sale en su tarjeta', async () => {
  empezar();
  const asesor = await asesorService.darDeAlta(validar(), 'admin-1');

  const guardada = await asesorService.editarFicha(
    asesor.id,
    validar({ especialidad: 'Salud pública', areas: ['SALUD'], anosExperiencia: 11 }),
  );
  assert.equal(guardada.especialidad, 'Salud pública');
  assert.deepEqual(guardada.areas, ['Salud']);
  assert.equal(guardada.anosExperiencia, 11);
  // Y sigue siendo el mismo, con su mismo enlace.
  assert.equal(guardada.id, asesor.id);
  assert.equal(guardada.token, asesor.token);
});

test('rehacer el enlace apaga el anterior', async () => {
  empezar();
  const asesor = await asesorService.darDeAlta(validar(), 'admin-1');
  const rehecho = await asesorService.rehacerEnlace(asesor.id);

  assert.notEqual(rehecho.token, asesor.token);
  assert.ok(rehecho.enlacePanel.endsWith(`/asesor/${rehecho.token}`));
});

test('a quien no está aprobado no se le rehace ningún enlace', async () => {
  empezar();
  const convocatoria = await asesorService.crearConvocatoria({ nombre: 'Piloto' }, 'admin-1');
  const ficha = await asesorService.postular(convocatoria.slug, validar());

  await assert.rejects(() => asesorService.rehacerEnlace(ficha.id), /aprobados tienen enlace/i);
});

test('se le puede sacar del directorio sin rechazarlo', async () => {
  empezar();
  const asesor = await asesorService.darDeAlta(validar(), 'admin-1');

  const apagado = await asesorService.revisar(
    asesor.id,
    { estado: 'APROBADO', notas: 'Está lleno hasta octubre.', visible: false },
    'admin-1',
  );
  assert.equal(apagado.visible, false);
  assert.equal(apagado.estado, 'APROBADO', 'sigue siendo asesor, solo que no sale');
});

test('aprobar a quien ya tenía enlace no se lo cambia', async () => {
  empezar();
  const convocatoria = await asesorService.crearConvocatoria({ nombre: 'Piloto' }, 'admin-1');
  const ficha = await asesorService.postular(convocatoria.slug, validar());

  const aprobado = await asesorService.revisar(ficha.id, { estado: 'APROBADO', notas: '' }, 'admin-1');
  assert.ok(aprobado.token, 'al aprobarlo se le da su llave');

  // Devolverlo a pendiente y volver a aprobarlo no puede dejar muerto el
  // enlace que ya se le mandó.
  await asesorService.revisar(ficha.id, { estado: 'PENDIENTE', notas: '' }, 'admin-1');
  const otraVez = await asesorService.revisar(ficha.id, { estado: 'APROBADO', notas: '' }, 'admin-1');
  assert.equal(otraVez.token, aprobado.token);
});

test('el panel ve cuántas fichas lleva cada convocatoria y cuántas esperan', async () => {
  empezar();
  const convocatoria = await asesorService.crearConvocatoria({ nombre: 'Piloto' }, 'admin-1');
  const primera = await asesorService.postular(convocatoria.slug, validar());
  await asesorService.postular(convocatoria.slug, validar({ email: 'otro@correo.com' }));
  await asesorService.revisar(primera.id, { estado: 'APROBADO', notas: '' }, 'admin-1');

  const [fila] = await asesorService.listarConvocatorias();
  assert.equal(fila.fichas, 2);
  assert.equal(fila.pendientes, 1);
  assert.ok(fila.url.endsWith(`/asesores/${convocatoria.slug}`));
});

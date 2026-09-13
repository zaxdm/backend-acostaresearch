'use strict';

/**
 * El Libro de Reclamaciones.
 *
 * Lo que se prueba: el plazo de quince días hábiles contado en Lima, el número
 * de la hoja, lo que acepta el formulario, que un correo que no sale no pierde
 * la hoja, que lo escrito por el consumidor llega escapado al correo, y que una
 * respuesta no se reescribe. La base, el correo y los avisos se sustituyen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const estado = { filas: new Map(), siguiente: 1, correos: [], correoRompe: false, avisos: [] };

sustituir('../src/lib/prisma', {
  reclamo: {
    create: async ({ data }) => {
      const fila = {
        numero: estado.siguiente++,
        respuesta: null,
        respondidoAt: null,
        respondidoPorId: null,
        ...data,
      };
      estado.filas.set(fila.numero, fila);
      return { ...fila };
    },
    findUnique: async ({ where }) => {
      const fila = estado.filas.get(where.numero);
      return fila ? { ...fila } : null;
    },
    findMany: async () => [...estado.filas.values()].reverse().map((fila) => ({ ...fila })),
    updateMany: async ({ where, data }) => {
      const fila = estado.filas.get(where.numero);
      if (!fila || (where.respondidoAt === null && fila.respondidoAt !== null)) return { count: 0 };
      Object.assign(fila, data);
      return { count: 1 };
    },
  },
  user: { findFirst: async () => ({ email: 'admin@acosta.test' }) },
});
sustituir('../src/lib/mailer', {
  sendMail: async (correo) => {
    if (estado.correoRompe) throw new Error('SMTP caído');
    estado.correos.push(correo);
  },
});
sustituir('../src/lib/notify', { avisarAlAdmin: (aviso) => estado.avisos.push(aviso) });

const { sumarDiasHabiles, codigoDeHoja } = require('../src/modules/reclamos/reclamo.plazo');
const { reclamoBodySchema } = require('../src/modules/reclamos/reclamo.schema');
const reclamoService = require('../src/modules/reclamos/reclamo.service');

const enLima = (fecha) => fecha.toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
const esperarCorreosSueltos = () => new Promise((listo) => setImmediate(listo));

function empezar() {
  estado.filas.clear();
  estado.siguiente = 1;
  estado.correos.length = 0;
  estado.avisos.length = 0;
  estado.correoRompe = false;
}

const hojaValida = (cambios = {}) => ({
  tipo: 'RECLAMO',
  nombre: 'Rosa Quispe Mamani',
  tipoDocumento: 'DNI',
  numeroDocumento: '45678912',
  domicilio: 'Av. España 123, Trujillo',
  telefono: '+51 987 654 321',
  email: 'Rosa@Correo.com',
  menorDeEdad: false,
  apoderado: '',
  tipoBien: 'SERVICIO',
  montoReclamado: '120.50',
  descripcionBien: 'Licencia del método de tesis',
  detalle: 'Pagué por Yape y después de tres días sigo sin acceso al conector.',
  pedido: 'Que activen mi acceso o me devuelvan el dinero.',
  ...cambios,
});

// ── El plazo y el número ────────────────────────────────────────────────────

test('quince días hábiles saltan sábados y domingos', () => {
  // Lunes 14 de septiembre de 2026 → lunes 5 de octubre.
  assert.equal(enLima(sumarDiasHabiles(new Date('2026-09-14T15:00:00Z'))), '2026-10-05');
  // Viernes 18 y sábado 19 → viernes 9 de octubre: el fin de semana no cuenta.
  assert.equal(enLima(sumarDiasHabiles(new Date('2026-09-18T15:00:00Z'))), '2026-10-09');
  assert.equal(enLima(sumarDiasHabiles(new Date('2026-09-19T15:00:00Z'))), '2026-10-09');
});

test('el plazo se cuenta en Lima: un viernes a las 23:30 sigue siendo viernes', () => {
  // En UTC ya es sábado. Contado desde el sábado, el límite caería un día antes
  // de lo que pide contar desde el viernes de Lima.
  assert.equal(enLima(sumarDiasHabiles(new Date('2026-09-19T04:30:00Z'))), '2026-10-09');
});

test('el número de hoja lleva nueve cifras y el año de Lima', () => {
  assert.equal(codigoDeHoja(1, new Date('2026-09-14T15:00:00Z')), '000000001-2026');
  // Las diez de la noche del 31 de diciembre en Lima: todavía es 2026.
  assert.equal(codigoDeHoja(42, new Date('2027-01-01T03:00:00Z')), '000000042-2026');
});

// ── El formulario ───────────────────────────────────────────────────────────

test('una hoja completa pasa, con el correo en minúsculas y el monto como número', () => {
  const resultado = reclamoBodySchema.safeParse(hojaValida());
  assert.equal(resultado.success, true);
  assert.equal(resultado.data.email, 'rosa@correo.com');
  assert.equal(resultado.data.montoReclamado, 120.5);
});

test('sin monto es válido y queda nulo', () => {
  for (const monto of ['', null, undefined]) {
    const resultado = reclamoBodySchema.safeParse(hojaValida({ montoReclamado: monto }));
    assert.equal(resultado.success, true, `monto ${monto}`);
    assert.equal(resultado.data.montoReclamado, null);
  }
});

test('un DNI de siete cifras no pasa, y el error va en su campo', () => {
  const resultado = reclamoBodySchema.safeParse(hojaValida({ numeroDocumento: '4567891' }));
  assert.equal(resultado.success, false);
  const problema = resultado.error.issues.find((i) => i.path[0] === 'numeroDocumento');
  assert.match(problema.message, /8 dígitos/);
});

test('un menor de edad tiene que decir quién es su padre, madre o apoderado', () => {
  const sinApoderado = reclamoBodySchema.safeParse(hojaValida({ menorDeEdad: true }));
  assert.equal(sinApoderado.success, false);
  assert.equal(sinApoderado.error.issues[0].path[0], 'apoderado');

  const conApoderado = reclamoBodySchema.safeParse(
    hojaValida({ menorDeEdad: true, apoderado: 'Juan Quispe' }),
  );
  assert.equal(conApoderado.success, true);
});

test('solo hay reclamos y quejas', () => {
  assert.equal(reclamoBodySchema.safeParse(hojaValida({ tipo: 'SUGERENCIA' })).success, false);
});

// ── Registrar ───────────────────────────────────────────────────────────────

test('registrar guarda la hoja, manda la copia al consumidor y avisa sin datos personales', async () => {
  empezar();
  const datos = reclamoBodySchema.parse(hojaValida());

  const { reclamo, correoEnviado } = await reclamoService.registrar(datos);
  await esperarCorreosSueltos();

  assert.equal(correoEnviado, true);
  assert.match(reclamo.codigo, /^000000001-\d{4}$/);
  assert.ok(reclamo.fechaLimite > reclamo.createdAt, 'el límite es posterior a la hoja');

  const copia = estado.correos.find((c) => c.to === 'rosa@correo.com');
  assert.ok(copia, 'el consumidor recibe su copia');
  assert.match(copia.subject, /000000001/);
  assert.match(copia.text, /días hábiles/);

  assert.ok(
    estado.correos.some((c) => c.to === 'admin@acosta.test' || c.to === process.env.ADMIN_NOTIFY_EMAIL),
    'el administrador recibe el aviso',
  );

  const [aviso] = estado.avisos;
  assert.doesNotMatch(`${aviso.titulo} ${aviso.mensaje}`, /Rosa|correo\.com/);
});

test('lo que escribe el consumidor llega escapado al HTML del correo', async () => {
  empezar();
  const datos = reclamoBodySchema.parse(
    hojaValida({ detalle: 'Mira <a href="https://malo.example">aquí</a> lo que pasó.' }),
  );

  await reclamoService.registrar(datos);

  const copia = estado.correos.find((c) => c.to === 'rosa@correo.com');
  assert.doesNotMatch(copia.html, /<a href="https:\/\/malo/);
  assert.match(copia.html, /&lt;a href=&quot;https:\/\/malo/);
});

test('si el correo no sale, la hoja se queda en el libro', async () => {
  empezar();
  estado.correoRompe = true;

  const { reclamo, correoEnviado } = await reclamoService.registrar(
    reclamoBodySchema.parse(hojaValida()),
  );

  assert.equal(correoEnviado, false);
  assert.ok(estado.filas.has(reclamo.numero));
});

// ── Responder ───────────────────────────────────────────────────────────────

test('responder guarda la respuesta y se la manda al consumidor; una segunda no entra', async () => {
  empezar();
  const { reclamo } = await reclamoService.registrar(reclamoBodySchema.parse(hojaValida()));
  estado.correos.length = 0;

  const { reclamo: respondido, correoEnviado } = await reclamoService.responder(
    reclamo.numero,
    'Activamos tu acceso hoy. Disculpa la demora.',
    'admin-1',
  );

  assert.equal(correoEnviado, true);
  assert.equal(respondido.respondido, true);
  assert.equal(respondido.respondidoPorId, 'admin-1');
  const correo = estado.correos.find((c) => c.to === 'rosa@correo.com');
  assert.match(correo.text, /Activamos tu acceso hoy/);

  await assert.rejects(
    reclamoService.responder(reclamo.numero, 'Otra respuesta distinta.', 'admin-2'),
    /ya tiene respuesta/,
  );
  assert.equal(estado.filas.get(reclamo.numero).respondidoPorId, 'admin-1', 'no se pisa la primera');
});

test('responder una hoja que no existe da 404', async () => {
  empezar();
  await assert.rejects(reclamoService.responder(999, 'Una respuesta cualquiera.', 'admin-1'), {
    statusCode: 404,
  });
});

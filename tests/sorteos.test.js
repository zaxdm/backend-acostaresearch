'use strict';

/**
 * Los sorteos de una matrícula.
 *
 * Lo que se prueba: que un correo se apunta una sola vez, que un sorteo cerrado
 * o ya hecho no admite a nadie, que el ganador es uno de los inscritos y se fija
 * una sola vez, que su código va sin revisar el buzón y sin el correo de compra,
 * y que un correo que no sale no deshace el sorteo. La base, el correo y los
 * códigos se sustituyen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const estado = {
  sorteos: new Map(),
  participantes: [],
  correos: [],
  correoRompe: false,
  codigos: [],
  anulados: [],
  siguiente: 1,
};

const uuid = () => `00000000-0000-4000-8000-${String(estado.siguiente++).padStart(12, '0')}`;
const conInscritos = (sorteo) => ({
  ...sorteo,
  participantes: estado.participantes
    .filter((p) => p.sorteoId === sorteo.id)
    .map(({ id, email, nombre, eliminadoEn = null, createdAt }) => ({
      id,
      email,
      nombre,
      eliminadoEn,
      createdAt,
    })),
  _count: { participantes: estado.participantes.filter((p) => p.sorteoId === sorteo.id).length },
});
const porDonde = (where) =>
  where.id ? estado.sorteos.get(where.id) : [...estado.sorteos.values()].find((s) => s.slug === where.slug);

sustituir('../src/lib/prisma', {
  activationCode: {
    findFirst: async ({ where }) =>
      estado.anulados.canjeado && where.status === 'REDEEMED' ? { id: 'canjeado' } : null,
    updateMany: async ({ where }) => {
      estado.anulados.push(where);
      return { count: 1 };
    },
  },
  plan: { findFirst: async () => ({ name: 'Método de tesis', durationDays: 90 }) },
  sorteo: {
    create: async ({ data }) => {
      const fila = {
        id: uuid(),
        abierto: true,
        ganadorId: null,
        ronda: 0,
        sorteadoAt: null,
        codigoHint: null,
        correoEnviado: false,
        createdAt: new Date(),
        ...data,
      };
      estado.sorteos.set(fila.id, fila);
      return conInscritos(fila);
    },
    findUnique: async ({ where }) => {
      const fila = porDonde(where);
      return fila ? conInscritos(fila) : null;
    },
    findMany: async () => [...estado.sorteos.values()].map(conInscritos),
    update: async ({ where, data }) => Object.assign(estado.sorteos.get(where.id), data),
    updateMany: async ({ where, data }) => {
      const fila = estado.sorteos.get(where.id);
      if (!fila || (where.ganadorId === null && fila.ganadorId !== null)) return { count: 0 };
      if (where.ronda !== undefined && fila.ronda !== where.ronda) return { count: 0 };
      Object.assign(fila, data);
      return { count: 1 };
    },
    delete: async ({ where }) => estado.sorteos.delete(where.id),
  },
  sorteoParticipante: {
    create: async ({ data }) => {
      if (estado.participantes.some((p) => p.sorteoId === data.sorteoId && p.email === data.email)) {
        throw Object.assign(new Error('Unique'), { code: 'P2002' });
      }
      const fila = { id: uuid(), createdAt: new Date(), ...data };
      estado.participantes.push(fila);
      return fila;
    },
    findUnique: async ({ where }) => estado.participantes.find((p) => p.id === where.id) ?? null,
    update: async ({ where, data }) =>
      Object.assign(estado.participantes.find((p) => p.id === where.id), data),
    deleteMany: async ({ where }) => {
      const antes = estado.participantes.length;
      estado.participantes = estado.participantes.filter(
        (p) => !(p.id === where.id && p.sorteoId === where.sorteoId),
      );
      return { count: antes - estado.participantes.length };
    },
  },
});
sustituir('../src/lib/mailer', {
  sendMail: async (correo) => {
    if (estado.correoRompe) throw new Error('SMTP caído');
    estado.correos.push(correo);
  },
});
sustituir('../src/modules/licensing/license.service', {
  generateCodes: async (opciones) => {
    estado.codigos.push(opciones);
    return { codes: [estado.codigos.length === 1 ? 'ACR-AAAA-BBBB-CCCC' : 'ACR-DDDD-EEEE-FFFF'] };
  },
});

const { inscripcionSchema } = require('../src/modules/sorteos/sorteo.schema');
const sorteoService = require('../src/modules/sorteos/sorteo.service');

function empezar() {
  estado.sorteos.clear();
  estado.participantes = [];
  estado.correos.length = 0;
  estado.codigos.length = 0;
  estado.anulados = [];
  estado.correoRompe = false;
}

const inscribir = (slug, email, nombre = '') =>
  sorteoService.inscribir(slug, inscripcionSchema.parse({ email, nombre }));

test('un correo se apunta una sola vez, sin importar mayúsculas', async () => {
  empezar();
  const sorteo = await sorteoService.crear({ nombre: 'Sorteo de octubre' }, 'admin-1');
  assert.match(sorteo.url, /\/sorteo\/[a-z2-9]{12}$/);

  await inscribir(sorteo.slug, 'Ana@Gmail.com', 'Ana');
  await assert.rejects(inscribir(sorteo.slug, ' ana@gmail.com '), /ya está participando/);

  const publico = await sorteoService.verPublico(sorteo.slug);
  assert.equal(publico.inscritos, 1);
  assert.equal(publico.duracionDias, 90);
  assert.equal(publico.abierto, true);
});

test('un sorteo cerrado no admite inscripciones', async () => {
  empezar();
  const sorteo = await sorteoService.crear({ nombre: 'Cerrado' }, 'admin-1');
  await sorteoService.cambiar(sorteo.id, { abierto: false });
  await assert.rejects(inscribir(sorteo.slug, 'beto@gmail.com'), /cerradas/);
});

test('sin inscritos no se puede sortear', async () => {
  empezar();
  const sorteo = await sorteoService.crear({ nombre: 'Vacío' }, 'admin-1');
  await assert.rejects(sorteoService.sortear(sorteo.id, 'admin-1'), /nadie inscrito/);
});

test('las dos primeras vueltas eliminan y la tercera da el ganador', async () => {
  empezar();
  const sorteo = await sorteoService.crear({ nombre: 'Tres vueltas' }, 'admin-1');
  const correos = ['a@gmail.com', 'b@gmail.com', 'c@gmail.com', 'd@gmail.com', 'e@gmail.com'];
  for (const correo of correos) await inscribir(sorteo.slug, correo);

  const v1 = await sorteoService.sortear(sorteo.id, 'admin-1');
  assert.equal(v1.tipo, 'ELIMINADO');
  assert.equal(v1.ronda, 1);
  assert.equal(v1.participantes.length, 5);
  assert.equal(v1.participantes[v1.indice].email, v1.eliminado.email);
  assert.equal(v1.sorteo.abierto, false, 'la primera vuelta cierra las inscripciones');
  assert.equal(estado.codigos.length, 0);
  await assert.rejects(sorteoService.quitarParticipante(sorteo.id, v1.eliminado.id), /ya empezó/);

  const v2 = await sorteoService.sortear(sorteo.id, 'admin-1');
  assert.equal(v2.tipo, 'ELIMINADO');
  assert.equal(v2.ronda, 2);
  assert.equal(v2.participantes.length, 4);
  assert.ok(!v2.participantes.some((p) => p.id === v1.eliminado.id), 'el primero ya no gira');

  const v3 = await sorteoService.sortear(sorteo.id, 'admin-1');
  assert.equal(v3.tipo, 'GANADOR');
  assert.equal(v3.ronda, 3);
  assert.equal(v3.participantes.length, 3);
  assert.ok(![v1.eliminado.id, v2.eliminado.id].includes(v3.ganador.id));
  assert.equal(estado.codigos.length, 1);
  assert.equal(estado.correos.length, 1);
});

test('con dos inscritos, la segunda vuelta ya da el ganador', async () => {
  empezar();
  const sorteo = await sorteoService.crear({ nombre: 'Dos' }, 'admin-1');
  await inscribir(sorteo.slug, 'a@gmail.com');
  await inscribir(sorteo.slug, 'b@gmail.com');
  assert.equal((await sorteoService.sortear(sorteo.id, 'admin-1')).tipo, 'ELIMINADO');
  const r = await sorteoService.sortear(sorteo.id, 'admin-1');
  assert.equal(r.tipo, 'GANADOR');
  assert.equal(r.participantes.length, 1);
});

test('el ganador recibe su código por correo y no se sortea dos veces', async () => {
  empezar();
  const sorteo = await sorteoService.crear({ nombre: 'Sorteo de octubre' }, 'admin-1');
  for (const correo of ['a@gmail.com', 'b@gmail.com', 'c@gmail.com']) await inscribir(sorteo.slug, correo);

  await sorteoService.sortear(sorteo.id, 'admin-1');
  await sorteoService.sortear(sorteo.id, 'admin-1');
  const r = await sorteoService.sortear(sorteo.id, 'admin-1');
  assert.equal(r.tipo, 'GANADOR');
  assert.ok(['a@gmail.com', 'b@gmail.com', 'c@gmail.com'].includes(r.ganador.email));
  assert.equal(r.participantes[r.indice].email, r.ganador.email);
  assert.equal(r.correoEnviado, true);
  // El panel no ve el código entero: solo el ganador, por correo.
  assert.equal(r.codigoOculto, 'ACR-AAAA-BBBB-****');
  assert.equal(r.codigo, undefined);

  // El código va sin revisar el buzón y sin el correo de compra.
  assert.equal(estado.codigos.length, 1);
  assert.equal(estado.codigos[0].revisarBuzon, false);
  assert.equal(estado.codigos[0].avisar, false);
  assert.equal(estado.codigos[0].paymentMethod, 'CORTESIA');
  assert.equal(estado.codigos[0].buyerEmail, r.ganador.email);

  assert.equal(estado.correos.length, 1);
  assert.equal(estado.correos[0].to, r.ganador.email);
  assert.match(estado.correos[0].text, /ACR-AAAA-BBBB-CCCC/);
  assert.match(estado.correos[0].text, /90 días/);

  assert.equal(r.sorteo.ganador.email, r.ganador.email);
  assert.equal(r.sorteo.abierto, false);
  assert.equal(r.sorteo.codigoHint, undefined);

  await assert.rejects(sorteoService.sortear(sorteo.id, 'admin-1'), /ya se realizó/);
  await assert.rejects(inscribir(sorteo.slug, 'tarde@gmail.com'), /ya se realizó/);
  await assert.rejects(sorteoService.cambiar(sorteo.id, { abierto: true }), /no se puede reabrir/);
});

test('si el correo no sale, el sorteo queda hecho y el código en pantalla', async () => {
  empezar();
  const sorteo = await sorteoService.crear({ nombre: 'Sin correo' }, 'admin-1');
  await inscribir(sorteo.slug, 'solo@gmail.com');
  estado.correoRompe = true;

  const r = await sorteoService.sortear(sorteo.id, 'admin-1');
  assert.equal(r.correoEnviado, false);
  assert.equal(r.codigoOculto, 'ACR-AAAA-BBBB-****');
  assert.equal(r.sorteo.ganador.email, 'solo@gmail.com');
  assert.equal(r.sorteo.correoEnviado, false);
});

test('el correo del ganador escapa su nombre', async () => {
  empezar();
  const sorteo = await sorteoService.crear({ nombre: 'Escape' }, 'admin-1');
  await inscribir(sorteo.slug, 'x@hotmail.com', '<b>Pepe</b>');
  await sorteoService.sortear(sorteo.id, 'admin-1');
  assert.doesNotMatch(estado.correos[0].html, /<b>Pepe/);
});

test('solo admite proveedores conocidos o universidades, y señala las erratas', () => {
  const admite = (email) => inscripcionSchema.safeParse({ email });
  for (const bueno of ['a@gmail.com', 'b@hotmail.com', 'c@outlook.es', 'd@upn.edu.pe', 'e@yahoo.com']) {
    assert.equal(admite(bueno).success, true, bueno);
  }
  const errata = admite('zxdf@gmaiol.com');
  assert.equal(errata.success, false);
  assert.match(errata.error.issues[0].message, /zxdf@gmail\.com/);
  assert.match(admite('x@miempresa.com').error.issues[0].message, /Gmail, Hotmail/);
  assert.equal(admite('sin-arroba').success, false);
});

test('reenviar anula el código anterior y manda uno nuevo', async () => {
  empezar();
  const sorteo = await sorteoService.crear({ nombre: 'Reenvío' }, 'admin-1');
  await inscribir(sorteo.slug, 'gana@gmail.com');
  estado.correoRompe = true;
  await sorteoService.sortear(sorteo.id, 'admin-1');
  estado.correoRompe = false;

  const r = await sorteoService.reenviar(sorteo.id, 'admin-1');
  assert.equal(r.correoEnviado, true);
  assert.equal(r.codigoOculto, 'ACR-DDDD-EEEE-****');
  assert.equal(estado.anulados.length, 1);
  assert.equal(estado.anulados[0].hint, 'CCCC');
  assert.equal(estado.anulados[0].status, 'AVAILABLE');
  assert.match(estado.correos.at(-1).text, /ACR-DDDD-EEEE-FFFF/);
});

test('no se reenvía si el ganador ya canjeó, ni sin ganador', async () => {
  empezar();
  const sorteo = await sorteoService.crear({ nombre: 'Canjeado' }, 'admin-1');
  await assert.rejects(sorteoService.reenviar(sorteo.id, 'admin-1'), /todavía no tiene ganador/);
  await inscribir(sorteo.slug, 'gana@gmail.com');
  await sorteoService.sortear(sorteo.id, 'admin-1');
  estado.anulados.canjeado = true;
  await assert.rejects(sorteoService.reenviar(sorteo.id, 'admin-1'), /ya canjeó/);
});

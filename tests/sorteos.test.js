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
  siguiente: 1,
};

const uuid = () => `00000000-0000-4000-8000-${String(estado.siguiente++).padStart(12, '0')}`;
const conInscritos = (sorteo) => ({
  ...sorteo,
  participantes: estado.participantes
    .filter((p) => p.sorteoId === sorteo.id)
    .map(({ id, email, nombre, createdAt }) => ({ id, email, nombre, createdAt })),
  _count: { participantes: estado.participantes.filter((p) => p.sorteoId === sorteo.id).length },
});
const porDonde = (where) =>
  where.id ? estado.sorteos.get(where.id) : [...estado.sorteos.values()].find((s) => s.slug === where.slug);

sustituir('../src/lib/prisma', {
  plan: { findFirst: async () => ({ name: 'Método de tesis', durationDays: 90 }) },
  sorteo: {
    create: async ({ data }) => {
      const fila = {
        id: uuid(),
        abierto: true,
        ganadorId: null,
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
    return { codes: ['ACOSTA-AAAA-BBBB'] };
  },
});

const { inscripcionSchema } = require('../src/modules/sorteos/sorteo.schema');
const sorteoService = require('../src/modules/sorteos/sorteo.service');

function empezar() {
  estado.sorteos.clear();
  estado.participantes = [];
  estado.correos.length = 0;
  estado.codigos.length = 0;
  estado.correoRompe = false;
}

const inscribir = (slug, email, nombre = '') =>
  sorteoService.inscribir(slug, inscripcionSchema.parse({ email, nombre }));

test('un correo se apunta una sola vez, sin importar mayúsculas', async () => {
  empezar();
  const sorteo = await sorteoService.crear({ nombre: 'Sorteo de octubre' }, 'admin-1');
  assert.match(sorteo.url, /\/sorteo\/[a-z2-9]{12}$/);

  await inscribir(sorteo.slug, 'Ana@Correo.com', 'Ana');
  await assert.rejects(inscribir(sorteo.slug, ' ana@correo.com '), /ya está participando/);

  const publico = await sorteoService.verPublico(sorteo.slug);
  assert.equal(publico.inscritos, 1);
  assert.equal(publico.duracionDias, 90);
  assert.equal(publico.abierto, true);
});

test('un sorteo cerrado no admite inscripciones', async () => {
  empezar();
  const sorteo = await sorteoService.crear({ nombre: 'Cerrado' }, 'admin-1');
  await sorteoService.cambiar(sorteo.id, { abierto: false });
  await assert.rejects(inscribir(sorteo.slug, 'beto@correo.com'), /cerradas/);
});

test('sin inscritos no se puede sortear', async () => {
  empezar();
  const sorteo = await sorteoService.crear({ nombre: 'Vacío' }, 'admin-1');
  await assert.rejects(sorteoService.sortear(sorteo.id, 'admin-1'), /nadie inscrito/);
});

test('el ganador es un inscrito, recibe su código por correo y no se sortea dos veces', async () => {
  empezar();
  const sorteo = await sorteoService.crear({ nombre: 'Sorteo de octubre' }, 'admin-1');
  for (const correo of ['a@x.com', 'b@x.com', 'c@x.com']) await inscribir(sorteo.slug, correo);

  const r = await sorteoService.sortear(sorteo.id, 'admin-1');
  assert.ok(['a@x.com', 'b@x.com', 'c@x.com'].includes(r.ganador.email));
  assert.equal(r.participantes[r.indice].email, r.ganador.email);
  assert.equal(r.correoEnviado, true);
  assert.equal(r.codigo, 'ACOSTA-AAAA-BBBB');

  // El código va sin revisar el buzón y sin el correo de compra.
  assert.equal(estado.codigos.length, 1);
  assert.equal(estado.codigos[0].revisarBuzon, false);
  assert.equal(estado.codigos[0].avisar, false);
  assert.equal(estado.codigos[0].paymentMethod, 'CORTESIA');
  assert.equal(estado.codigos[0].buyerEmail, r.ganador.email);

  assert.equal(estado.correos.length, 1);
  assert.equal(estado.correos[0].to, r.ganador.email);
  assert.match(estado.correos[0].text, /ACOSTA-AAAA-BBBB/);
  assert.match(estado.correos[0].text, /90 días/);

  assert.equal(r.sorteo.ganador.email, r.ganador.email);
  assert.equal(r.sorteo.abierto, false);
  assert.equal(r.sorteo.codigoHint, 'BBBB');

  await assert.rejects(sorteoService.sortear(sorteo.id, 'admin-1'), /ya se realizó/);
  await assert.rejects(inscribir(sorteo.slug, 'tarde@x.com'), /ya se realizó/);
  await assert.rejects(sorteoService.cambiar(sorteo.id, { abierto: true }), /no se puede reabrir/);
});

test('si el correo no sale, el sorteo queda hecho y el código en pantalla', async () => {
  empezar();
  const sorteo = await sorteoService.crear({ nombre: 'Sin correo' }, 'admin-1');
  await inscribir(sorteo.slug, 'solo@x.com');
  estado.correoRompe = true;

  const r = await sorteoService.sortear(sorteo.id, 'admin-1');
  assert.equal(r.correoEnviado, false);
  assert.equal(r.codigo, 'ACOSTA-AAAA-BBBB');
  assert.equal(r.sorteo.ganador.email, 'solo@x.com');
  assert.equal(r.sorteo.correoEnviado, false);
});

test('el correo del ganador escapa su nombre', async () => {
  empezar();
  const sorteo = await sorteoService.crear({ nombre: 'Escape' }, 'admin-1');
  await inscribir(sorteo.slug, 'x@x.com', '<b>Pepe</b>');
  await sorteoService.sortear(sorteo.id, 'admin-1');
  assert.doesNotMatch(estado.correos[0].html, /<b>Pepe/);
});

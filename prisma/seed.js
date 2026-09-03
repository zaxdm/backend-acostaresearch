'use strict';

/**
 * Datos iniciales. Es idempotente (usa upsert), así que se puede ejecutar
 * tantas veces como haga falta sin duplicar nada.
 *
 * Lo ejecutan automáticamente `npm run db:migrate` y `npm run db:reset`,
 * o a mano con `npm run db:seed`.
 */

const prisma = require('../src/lib/prisma');
const logger = require('../src/config/logger');
const { hashPassword } = require('../src/shared/utils/password');

const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL ?? 'admin@acostaresearch.com').toLowerCase();
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'Admin12345';

/**
 * Planes del humanizador. Los precios van en céntimos de sol.
 * Los costes anotados son estimaciones con Sonnet; revísalos cuando haya
 * mediciones reales en la tabla `rewrites`.
 *
 * `priceUsdCents` es el precio para PayPal, que no admite soles. No es la
 * conversión exacta: va algo por encima porque PayPal se queda en torno al
 * 5,4 % más una comisión fija por operación internacional. Con estos importes,
 * lo que llega a la cuenta se acerca al precio en soles. Cuando entren Culqi o
 * Mercado Pago, que sí cobran en soles, usarán `priceCents` y este campo
 * quedará solo para PayPal.
 */
const PLANES = [
  {
    code: 'PRUEBA',
    name: 'Prueba gratuita',
    description: 'Para que compruebes cómo reescribe antes de pagar.',
    words: 2000,
    priceCents: 0,
    durationDays: 30,
    sortOrder: 0,
  },
  {
    code: 'BASICO',
    name: 'Básico',
    description: 'Unos dos capítulos al mes. Ideal si vas avanzando por partes.',
    words: 10000,
    priceCents: 1900,
    priceUsdCents: 590,
    durationDays: 30,
    sortOrder: 1,
  },
  {
    code: 'TESISTA',
    name: 'Tesista',
    description: 'El plan pensado para quien está redactando su tesis ahora.',
    words: 30000,
    priceCents: 2900,
    priceUsdCents: 890,
    durationDays: 30,
    sortOrder: 2,
  },
  {
    code: 'INTENSIVO',
    name: 'Intensivo',
    description: 'Para cerrar la tesis completa o revisarla varias veces.',
    words: 80000,
    priceCents: 5900,
    priceUsdCents: 1790,
    durationDays: 30,
    sortOrder: 3,
  },
  {
    code: 'METODO_9_SKILLS',
    name: 'Método de tesis · 9 capítulos',
    description:
      'Acceso al método completo desde tu propio Claude: los 9 capítulos, capítulo por capítulo.',
    kind: 'LICENSE',
    productCode: 'METODO_9_SKILLS',
    // Un plan de licencia no entrega palabras; el campo existe por el esquema.
    words: 0,
    priceCents: 10000,
    priceUsdCents: 2990,
    // Vigencia de la licencia en días. 365 = un año de acceso al conector.
    durationDays: 365,
    sortOrder: 10,
  },
];

async function sembrarAdmin() {
  const passwordHash = await hashPassword(ADMIN_PASSWORD);

  const admin = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    // Si ya existe no se le pisa la contraseña: solo se garantiza que sigue
    // siendo un ADMIN activo y utilizable.
    update: { role: 'ADMIN', status: 'ACTIVE', emailVerifiedAt: new Date() },
    create: {
      email: ADMIN_EMAIL,
      passwordHash,
      firstName: 'Administrador',
      lastName: 'Acosta Research',
      role: 'ADMIN',
      status: 'ACTIVE',
      // Se marca verificado a mano: el seed no pasa por el flujo del código.
      emailVerifiedAt: new Date(),
    },
  });

  logger.info({ email: admin.email, role: admin.role }, 'Usuario administrador listo');

  if (!process.env.SEED_ADMIN_PASSWORD) {
    logger.warn(
      `Contraseña por defecto del admin: ${ADMIN_PASSWORD} · cámbiala o define SEED_ADMIN_PASSWORD`,
    );
  }
}

async function sembrarPlanes() {
  for (const plan of PLANES) {
    // Se actualizan palabras y precio, pero no se desactiva un plan que el
    // administrador haya apagado a mano desde la base de datos.
    await prisma.plan.upsert({
      where: { code: plan.code },
      update: {
        name: plan.name,
        description: plan.description,
        words: plan.words,
        kind: plan.kind ?? 'WORDS',
        productCode: plan.productCode ?? null,
        priceCents: plan.priceCents,
        priceUsdCents: plan.priceUsdCents ?? null,
        durationDays: plan.durationDays,
        sortOrder: plan.sortOrder,
      },
      create: plan,
    });
  }

  logger.info({ planes: PLANES.map((p) => p.code) }, 'Planes del humanizador listos');
}

async function main() {
  await sembrarAdmin();
  await sembrarPlanes();
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'Falló la carga de datos iniciales');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

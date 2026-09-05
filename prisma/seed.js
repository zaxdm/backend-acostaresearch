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
  // ── Bolsas del humanizador ─────────────────────────────────────────────
  //
  // Fuera de la venta mientras el humanizador no tenga clave de Anthropic.
  // Cobrar por un servicio que no puede responder es la peor forma de perder
  // un cliente: paga, falla y pide la devolución.
  //
  // Se dejan definidos —no borrados— porque el precio y los topes ya estaban
  // pensados. Para reabrirlos basta con quitar `active: false` de los tres y
  // volver a sembrar; la clave en ANTHROPIC_API_KEY es lo que falta.
  {
    code: 'BASICO',
    name: 'Básico',
    description: 'Unos dos capítulos al mes. Ideal si vas avanzando por partes.',
    words: 10000,
    priceCents: 1900,
    priceUsdCents: 590,
    durationDays: 30,
    sortOrder: 1,
    active: false,
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
    active: false,
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
    active: false,
  },
  {
    code: 'METODO_9_SKILLS',
    name: 'Método de tesis · 9 capítulos',
    description:
      'Tres meses con el método completo desde tu propio Claude, capítulo por capítulo.',
    kind: 'LICENSE',
    productCode: 'METODO_9_SKILLS',
    // Un plan de licencia no entrega palabras; el campo existe por el esquema.
    words: 0,
    priceCents: 19900,
    // S/199 son unos $54; se cobra algo más para absorber la comisión
    // internacional de PayPal y que lo que llega se acerque al precio anunciado.
    priceUsdCents: 5790,
    // Tres meses de acceso. Es el tiempo de un ciclo de tesis: el tesista
    // trabaja con el método el trimestre que lo necesita, y quien tarde más
    // renueva. Renovar alarga la MISMA licencia, así que no tiene que volver a
    // instalar el conector ni cambiar la URL que ya tiene en Claude.
    durationDays: 90,
    //
    // ENTREGA. El método viaja al Claude del comprador y trabaja él, así que
    // atenderlo no nos cuesta un solo token, ni durante estos tres meses ni en
    // las renovaciones.
    mcpDelivery: 'INSTRUCTIONS',
    //
    // TOPES. Sin coste que contener, los frenos de gasto sobran: atender este
    // producto no consume tokens nuestros, así que un tope mensual o total solo
    // acotaría una factura que no existe. Se quitan todos menos uno.
    //
    // El diario no es un límite de uso: es la única barrera contra la descarga
    // sistemática, porque en modo INSTRUCTIONS el método sí viaja al Claude del
    // comprador. El método completo son ~101 tramos, así que este tope permite
    // vaciarlo casi cinco veces en un mismo día.
    //
    // Se fija alto a propósito, con el uso real muy por debajo —el día más
    // intenso registrado fueron 34 consultas y la media son 10—, de modo que
    // ningún tesista pueda toparse con él. La contrapartida es que la
    // protección efectiva ya no la da este número, sino el rastro que deja en
    // el registro pedir tramos sin trabajar ninguno, que es lo que mira
    // `license.detector`. Conviene revisar las alertas con más frecuencia.
    mcpCallsPerDay: 500,
    mcpCallsPerMonth: 0,
    mcpCostCentsPerMonth: 0,
    mcpCallsTotal: 0,
    mcpCostCentsTotal: 0,
    sortOrder: 10,
  },
  {
    // RETIRADO. Existió mientras hubo dos versiones del método —una ejecutada
    // en nuestro servidor y otra entregada al comprador—. Ahora solo hay una,
    // la entregada, y se vende a S/199 bajo METODO_9_SKILLS.
    //
    // No se borra: hay licencias emitidas con este código y el histórico de
    // pagos lo referencia. Apagado deja de listarse y deja de poder comprarse.
    code: 'METODO_9_GUIAS',
    name: 'Método de tesis · guías (retirado)',
    description: 'Reemplazado por el plan único de S/199.',
    kind: 'LICENSE',
    productCode: 'METODO_9_GUIAS',
    words: 0,
    priceCents: 9900,
    priceUsdCents: 2990,
    durationDays: 0,
    active: false,
    mcpCallsPerDay: 200,
    mcpCallsPerMonth: 0,
    mcpCostCentsPerMonth: 0,
    mcpCallsTotal: 0,
    mcpCostCentsTotal: 0,
    mcpDelivery: 'INSTRUCTIONS',
    sortOrder: 11,
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
    // administrador haya apagado a mano desde la base de datos. La excepción es
    // un plan que declare `active` aquí: eso es una decisión del catálogo, no
    // un apagado temporal, y tiene que imponerse al volver a sembrar.
    await prisma.plan.upsert({
      where: { code: plan.code },
      update: {
        ...(plan.active === undefined ? {} : { active: plan.active }),
        name: plan.name,
        description: plan.description,
        words: plan.words,
        kind: plan.kind ?? 'WORDS',
        productCode: plan.productCode ?? null,
        mcpCallsPerDay: plan.mcpCallsPerDay ?? 0,
        mcpCallsPerMonth: plan.mcpCallsPerMonth ?? 0,
        mcpCostCentsPerMonth: plan.mcpCostCentsPerMonth ?? 0,
        mcpCallsTotal: plan.mcpCallsTotal ?? 0,
        mcpCostCentsTotal: plan.mcpCostCentsTotal ?? 0,
        mcpDelivery: plan.mcpDelivery ?? 'EXECUTED',
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

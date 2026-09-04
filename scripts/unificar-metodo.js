'use strict';

/**
 * Pasa las licencias ya emitidas al plan único de S/199.
 *
 * Hace falta porque los topes y la forma de entrega se copian a la licencia EN
 * EL MOMENTO de emitirla: cambiar el plan no toca a quien ya compró. Las
 * licencias vivas quedaron con la configuración antigua, y dos cosas de esa
 * configuración ya no valen:
 *
 *   · `delivery: EXECUTED` — pedía ejecutar la skill en nuestro servidor con la
 *     clave de Anthropic. Sin clave, esas licencias no sirven para nada: el
 *     conector responde que el capítulo está pendiente de publicar.
 *   · Topes de gasto y de consultas totales — acotaban una factura que ya no
 *     existe, porque entregar el método no consume tokens nuestros.
 *
 * También se retira la caducidad: el producto es permanente y una licencia con
 * fecha de vencimiento contradice lo que se vendió.
 *
 * Uso:
 *   npm run licenses:unificar               → muestra qué cambiaría, sin tocar nada
 *   npm run licenses:unificar -- --aplicar
 */

const prisma = require('../src/lib/prisma');
const logger = require('../src/config/logger');

const PRODUCTO = 'METODO_9_SKILLS';

async function main() {
  const aplicar = process.argv.includes('--aplicar');

  const plan = await prisma.plan.findFirst({
    where: { kind: 'LICENSE', productCode: PRODUCTO, active: true },
    select: {
      mcpCallsPerDay: true,
      mcpCallsPerMonth: true,
      mcpCostCentsPerMonth: true,
      mcpCallsTotal: true,
      mcpCostCentsTotal: true,
      mcpDelivery: true,
    },
  });

  if (!plan) {
    logger.error(`No hay plan activo para ${PRODUCTO}. Ejecuta antes: npm run seed`);
    process.exitCode = 1;
    return;
  }

  if (plan.mcpDelivery !== 'INSTRUCTIONS') {
    logger.warn(
      `El plan ${PRODUCTO} sigue en modo ${plan.mcpDelivery}. ` +
        'Sin ANTHROPIC_API_KEY las licencias no responderán.',
    );
  }

  const licencias = await prisma.license.findMany({
    select: {
      id: true,
      tokenHint: true,
      productCode: true,
      delivery: true,
      expiresAt: true,
      callsPerDay: true,
      callsLimitTotal: true,
      costCentsLimitTotal: true,
      user: { select: { email: true } },
    },
  });

  let tocadas = 0;

  for (const l of licencias) {
    const cambios = [];
    if (l.productCode !== PRODUCTO) cambios.push(`producto ${l.productCode} → ${PRODUCTO}`);
    if (l.delivery !== plan.mcpDelivery) cambios.push(`entrega ${l.delivery} → ${plan.mcpDelivery}`);
    if (l.expiresAt) cambios.push(`caducidad ${l.expiresAt.toISOString().slice(0, 10)} → nunca`);
    if (l.callsPerDay !== plan.mcpCallsPerDay) {
      cambios.push(`día ${l.callsPerDay} → ${plan.mcpCallsPerDay}`);
    }
    if (l.callsLimitTotal !== plan.mcpCallsTotal) {
      cambios.push(`total ${l.callsLimitTotal} → ${plan.mcpCallsTotal || 'sin tope'}`);
    }
    if (l.costCentsLimitTotal !== plan.mcpCostCentsTotal) {
      cambios.push(`gasto ${l.costCentsLimitTotal} → ${plan.mcpCostCentsTotal || 'sin tope'}`);
    }

    if (cambios.length === 0) continue;

    console.log(`  ${l.user.email.padEnd(30)} …${l.tokenHint}`);
    cambios.forEach((c) => console.log(`      ${c}`));

    if (aplicar) {
      await prisma.license.update({
        where: { id: l.id },
        data: {
          productCode: PRODUCTO,
          delivery: plan.mcpDelivery,
          expiresAt: null,
          callsPerDay: plan.mcpCallsPerDay,
          callsPerMonth: plan.mcpCallsPerMonth,
          costCentsPerMonth: plan.mcpCostCentsPerMonth,
          callsLimitTotal: plan.mcpCallsTotal,
          costCentsLimitTotal: plan.mcpCostCentsTotal,
        },
      });
    }
    tocadas += 1;
  }

  if (tocadas === 0) {
    logger.info('Todas las licencias ya están en el plan único.');
  } else if (aplicar) {
    logger.info({ licencias: tocadas }, 'Licencias unificadas');
  } else {
    logger.warn(`${tocadas} licencia(s) por migrar. Ejecuta con --aplicar para hacerlo.`);
  }
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'Falló la unificación de licencias');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

'use strict';

/**
 * Aplica a las licencias ya emitidas los topes que hoy tiene su plan.
 *
 * Hace falta porque los topes se copian a la licencia EN EL MOMENTO de
 * emitirla. Las que se emitieron antes de que el plan tuviera límites se
 * quedaron con ceros —es decir, sin límite— y sobre un producto vitalicio eso
 * significa uso ilimitado para siempre.
 *
 * Solo toca las que están a cero. Una licencia con topes propios (ampliados a
 * mano para un cliente, por ejemplo) se respeta: por eso no es un `updateMany`
 * a secas.
 *
 * Uso:
 *   npm run licenses:topes            → muestra qué cambiaría, sin tocar nada
 *   npm run licenses:topes -- --aplicar
 */

const prisma = require('../src/lib/prisma');
const logger = require('../src/config/logger');

async function main() {
  const aplicar = process.argv.includes('--aplicar');

  const planes = await prisma.plan.findMany({
    where: { kind: 'LICENSE', active: true },
    select: {
      productCode: true,
      code: true,
      mcpCallsPerDay: true,
      mcpCallsTotal: true,
      mcpCostCentsTotal: true,
    },
  });

  if (planes.length === 0) {
    logger.warn('No hay planes de licencia activos.');
    return;
  }

  let tocadas = 0;

  for (const plan of planes) {
    const producto = plan.productCode ?? plan.code;

    const sinTope = await prisma.license.findMany({
      where: {
        productCode: producto,
        // Sin tope total es como decir «uso ilimitado de por vida».
        callsLimitTotal: 0,
        costCentsLimitTotal: 0,
        // Los de prueba llevan los topes que eligió el administrador al crear el
        // enlace, cero incluido: no son los del plan.
        user: { trialLinkId: null },
      },
      select: { id: true, tokenHint: true, callsPerDay: true, user: { select: { email: true } } },
    });

    for (const licencia of sinTope) {
      console.log(
        `  ${licencia.user.email.padEnd(34)} …${licencia.tokenHint}  →  ` +
          `${plan.mcpCallsTotal} consultas · $${(plan.mcpCostCentsTotal / 100).toFixed(2)}`,
      );

      if (aplicar) {
        await prisma.license.update({
          where: { id: licencia.id },
          data: {
            // El diario solo se pone si no tenía ninguno, para no rebajarle
            // el cupo a alguien a quien se lo ampliaste a propósito.
            callsPerDay: licencia.callsPerDay > 0 ? licencia.callsPerDay : plan.mcpCallsPerDay,
            callsLimitTotal: plan.mcpCallsTotal,
            costCentsLimitTotal: plan.mcpCostCentsTotal,
          },
        });
      }
      tocadas += 1;
    }
  }

  if (tocadas === 0) {
    logger.info('Todas las licencias tienen sus topes puestos.');
  } else if (aplicar) {
    logger.info({ licencias: tocadas }, 'Topes aplicados');
  } else {
    logger.warn(
      `${tocadas} licencia(s) sin tope. Ejecuta con --aplicar para ponérselos.`,
    );
  }
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'Falló la aplicación de topes');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

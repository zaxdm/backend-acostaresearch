'use strict';

/**
 * Pasa el catálogo al modelo de grupos y a la suscripción trimestral.
 *
 * Hace tres cosas, todas repetibles sin daño:
 *
 *   1. Cuelga cada capítulo sin grupo del producto que lo vende, para que el
 *      conector siga sirviéndolos ahora que filtra por grupo.
 *   2. Pone el plan del método en 90 días.
 *   3. Le da caducidad a las licencias que no la tenían.
 *
 * Sobre el punto 3, que es el delicado: esas licencias se vendieron como
 * «acceso de por vida, sin suscripción». Ponerles caducidad cambia lo que esos
 * compradores pagaron, y es una decisión del negocio, no del código. Por eso
 * este paso NO se ejecuta solo: hay que pedirlo con --caducar, y el script
 * enseña antes a quién va a afectar.
 *
 *   node scripts/pasar-a-trimestre.js              ← solo enseña qué haría
 *   node scripts/pasar-a-trimestre.js --aplicar    ← grupos y plan
 *   node scripts/pasar-a-trimestre.js --aplicar --caducar   ← también licencias
 */

const prisma = require('../src/lib/prisma');

const GRUPO = process.env.LICENSE_PRODUCT_CODE || 'METODO_9_SKILLS';
const DIAS = 90;

const aplicar = process.argv.includes('--aplicar');
const caducar = process.argv.includes('--caducar');

function enDias(dias) {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() + dias);
  return fecha;
}

function fecha(valor) {
  return valor ? valor.toISOString().slice(0, 10) : 'sin caducidad';
}

async function main() {
  console.log(aplicar ? '── APLICANDO ──\n' : '── SIMULACIÓN (añade --aplicar) ──\n');

  // ── 1. Capítulos sin grupo ────────────────────────────────────────────────
  const plan = await prisma.plan.findFirst({
    where: { kind: 'LICENSE', productCode: GRUPO },
    select: { code: true, name: true, durationDays: true, priceCents: true },
  });

  if (!plan) {
    console.error(`No existe ningún plan con productCode «${GRUPO}». Siembra primero.`);
    process.exitCode = 1;
    return;
  }

  const huerfanas = await prisma.skill.findMany({
    where: { productCode: null },
    select: { code: true, orden: true },
    orderBy: { orden: 'asc' },
  });

  console.log(`CAPÍTULOS SIN GRUPO: ${huerfanas.length}`);
  for (const s of huerfanas) console.log(`   ${String(s.orden).padStart(2)} · ${s.code}`);
  console.log(`   → pasarían al grupo ${GRUPO}\n`);

  if (aplicar && huerfanas.length > 0) {
    const { count } = await prisma.skill.updateMany({
      where: { productCode: null },
      data: { productCode: GRUPO },
    });
    console.log(`   ✓ ${count} capítulos asignados\n`);
  }

  // ── 2. Duración del plan ──────────────────────────────────────────────────
  console.log(`PLAN ${plan.code}: ${plan.durationDays} días → ${DIAS} días`);
  console.log(`   precio S/ ${(plan.priceCents / 100).toFixed(2)}, sin cambios\n`);

  if (aplicar && plan.durationDays !== DIAS) {
    await prisma.plan.updateMany({
      where: { kind: 'LICENSE', productCode: GRUPO },
      data: { durationDays: DIAS },
    });
    console.log(`   ✓ plan a ${DIAS} días\n`);
  }

  // ── 3. Licencias sin caducidad ────────────────────────────────────────────
  const vitalicias = await prisma.license.findMany({
    where: { productCode: GRUPO, expiresAt: null, status: { not: 'REVOKED' } },
    select: { id: true, createdAt: true, user: { select: { email: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const nuevaCaducidad = enDias(DIAS);

  console.log(`LICENCIAS SIN CADUCIDAD: ${vitalicias.length}`);
  for (const l of vitalicias) {
    console.log(`   ${l.user.email}  (desde ${fecha(l.createdAt)})  → ${fecha(nuevaCaducidad)}`);
  }

  if (vitalicias.length > 0 && !caducar) {
    console.log(
      '\n   Se quedan como están. Estas licencias se vendieron como acceso\n' +
        '   permanente; para ponerles caducidad, añade --caducar.',
    );
  }

  if (aplicar && caducar && vitalicias.length > 0) {
    const { count } = await prisma.license.updateMany({
      where: { id: { in: vitalicias.map((l) => l.id) } },
      data: { expiresAt: nuevaCaducidad },
    });
    console.log(`\n   ✓ ${count} licencias caducan el ${fecha(nuevaCaducidad)}`);
    console.log('   Avísales antes de esa fecha: hoy no lo saben.');
  }

  console.log('\nListo.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

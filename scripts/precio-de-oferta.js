'use strict';

/**
 * Pone (o quita) el precio de oferta de los planes del catálogo.
 *
 * Una oferta son dos cifras a la vez: la que se cobra y la que se cobraba. Este
 * script las mueve juntas, que es la única forma de que no se separen —bajar el
 * precio en el panel y escribir el «antes» a mano en la plantilla acaba siempre
 * en una tarjeta que anuncia una rebaja y un cobro por el precio viejo—.
 *
 * Lo que se cobra es `priceCents`, aquí y en las pasarelas. `listPriceCents` es
 * solo el número tachado: no entra en ningún cálculo, ni en PayPal ni en el
 * comprobante de Yape.
 *
 *   node scripts/precio-de-oferta.js               ← enseña qué haría
 *   node scripts/precio-de-oferta.js --aplicar     ← lo aplica
 *   node scripts/precio-de-oferta.js --quitar --aplicar   ← vuelve al de lista
 *
 * Es repetible: aplicarlo dos veces deja lo mismo que aplicarlo una.
 *
 * Contra producción: descomenta su DATABASE_URL en .env, ejecútalo, y vuelve a
 * dejarla comentada. Solo hace UPDATE sobre `plans`; no borra nada.
 */

const prisma = require('../src/lib/prisma');

/**
 * La oferta vigente.
 *
 * `antes` es lo que cuesta fuera de oferta: es lo que se enseña tachado
 * mientras dura y lo que se restaura con --quitar. El precio en dólares no se
 * escribe aquí —se calcula—: el plan de artículos se creó desde el panel y su
 * importe en dólares solo lo sabe la base.
 */
const OFERTA = [
  { code: 'METODO_9_SKILLS', antes: 19900, ahora: 15900 },
  { code: 'ARTICULO_SCIENTIFICOS', antes: 25000, ahora: 22000 },
];

const aplicar = process.argv.includes('--aplicar');
const quitar = process.argv.includes('--quitar');

const soles = (cents) => `S/ ${(cents / 100).toFixed(2)}`;
const conAntes = (precio, antes) => `${soles(precio)}${antes ? ` (antes ${soles(antes)})` : ''}`;

/**
 * El precio en dólares, movido en la misma proporción que el de soles.
 *
 * Dejarlo quieto sería cobrar la oferta en Perú y el precio viejo fuera. Se
 * calcula sobre lo que hay en la base y se redondea a la decena, así que ir y
 * volver puede dejarlo unos céntimos por encima del original: es preferible a
 * una tabla de importes escrita aquí que se desincronice del panel.
 *
 * Un plan sin precio en dólares se queda sin él: no se puede comprar por PayPal
 * y la oferta no cambia eso.
 */
function enDolares(usdActual, deCents, aCents) {
  if (!usdActual || deCents <= 0) return usdActual ?? null;
  return Math.round((usdActual * aCents) / deCents / 10) * 10;
}

async function main() {
  console.log(aplicar ? '── APLICANDO ──\n' : '── SIMULACIÓN (añade --aplicar) ──\n');
  console.log(quitar ? 'Modo: QUITAR la oferta\n' : 'Modo: PONER la oferta\n');

  for (const item of OFERTA) {
    const plan = await prisma.plan.findUnique({
      where: { code: item.code },
      select: {
        code: true,
        name: true,
        priceCents: true,
        priceUsdCents: true,
        listPriceCents: true,
      },
    });

    // Un plan que no está no es un fallo: el catálogo de cada entorno es
    // distinto y en el local puede no existir el de artículos.
    if (!plan) {
      console.log(`${item.code}: no existe en esta base, se salta\n`);
      continue;
    }

    const precio = quitar ? item.antes : item.ahora;
    const destino = {
      priceCents: precio,
      listPriceCents: quitar ? null : item.antes,
      priceUsdCents: enDolares(plan.priceUsdCents, plan.priceCents, precio),
    };

    console.log(`${plan.code} · ${plan.name}`);
    console.log(`   ahora:  ${conAntes(plan.priceCents, plan.listPriceCents)}`);
    console.log(`   queda:  ${conAntes(destino.priceCents, destino.listPriceCents)}`);
    if (plan.priceUsdCents) {
      console.log(
        `   PayPal: $ ${(plan.priceUsdCents / 100).toFixed(2)} → $ ${(destino.priceUsdCents / 100).toFixed(2)}`,
      );
    }

    if (aplicar) {
      await prisma.plan.update({ where: { code: plan.code }, data: destino });
      console.log('   ✓ aplicado');
    }

    console.log();
  }

  if (!aplicar) console.log('Nada se ha tocado. Repite con --aplicar.');
}

main()
  .catch((error) => {
    console.error('Falló:', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

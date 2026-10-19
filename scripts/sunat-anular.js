'use strict';

/**
 * Anula una boleta aceptada con una nota de crédito (motivo 01) y la envía a
 * SUNAT, con las credenciales y el certificado del .env. Se corre en el
 * servidor:
 *
 *   node scripts/sunat-anular.js B001-3 "Código anulado: no fue una venta"
 *   node scripts/sunat-anular.js B001-2 "Producto equivocado" --refacturar
 *
 * Una nota aceptada NO se deshace. Si la venta sigue siendo una venta, se niega
 * salvo con --refacturar: entonces la pasada siguiente del servidor le hace
 * una boleta nueva con los datos de hoy.
 */

const prisma = require('../src/lib/prisma');
const { anular } = require('../src/modules/sunat/sunat.service');

async function main() {
  const args = process.argv.slice(2);
  const refacturar = args.includes('--refacturar');
  const [boleta, motivo] = args.filter((a) => a !== '--refacturar');
  const partes = /^(B[A-Z0-9]{3})-(\d+)$/.exec(boleta ?? '');
  if (!partes || !motivo) {
    console.error('Uso: node scripts/sunat-anular.js B001-3 "motivo" [--refacturar]');
    process.exitCode = 1;
    return;
  }
  const resultado = await anular({ serie: partes[1], numero: Number(partes[2]), motivo, refacturar });
  console.log(JSON.stringify({ anula: boleta, ...resultado }, null, 2));
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

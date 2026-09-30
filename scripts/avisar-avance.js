'use strict';

/**
 * Los correos según el avance del tesista, a mano.
 *
 * No hace falta para que salgan: el servidor los manda solo una vez al día
 * (ver `modules/avisos` y `server.js`). Esto sirve para mirar a quién se
 * escribiría sin mandar nada, o para forzar la pasada de hoy.
 *
 * Uso:  npm run avisos:avance -- --ver    enseña a quién escribiría y qué
 *       npm run avisos:avance             manda los de hoy (lo que no se mandó ya)
 */

const prisma = require('../src/lib/prisma');
const avisosService = require('../src/modules/avisos/avisos.service');

const soloVer = process.argv.includes('--ver');

avisosService
  .enviarDelDia({ soloVer })
  .then(({ enviados, fallados, lista }) => {
    if (soloVer) {
      for (const fila of lista) console.log(`  ${fila.tipo.padEnd(14)} ${fila.email} · ${fila.producto}`);
      console.log(`prueba: ${lista.length} correos saldrían`);
    } else {
      console.log(`${enviados} enviados${fallados ? `, ${fallados} fallaron` : ''}`);
      if (fallados > 0 && enviados === 0) process.exitCode = 1;
    }
  })
  .catch((error) => {
    console.error('No se pudo hacer la pasada de avisos:', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

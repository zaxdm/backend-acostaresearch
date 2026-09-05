'use strict';

/**
 * Trae el último respaldo del servidor a este equipo.
 *
 * Por qué existe: la copia diaria del servidor protege de un borrado por error,
 * pero no de que el disco muera o de que alguien destruya la máquina. Un
 * respaldo que vive en el mismo sitio que el original no es un respaldo.
 *
 * Dentro van los 31 bundles, los comprobantes de Yape y el .env de producción.
 * Es decir: SECRETOS. La carpeta de destino está en .gitignore, y aun así
 * conviene no dejarla en sitios compartidos.
 *
 * Uso:  npm run backup:traer
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DESTINO = path.resolve(__dirname, '..', 'respaldos');

function enServidor(orden) {
  return execFileSync('ssh', ['-o', 'BatchMode=yes', 'acosta', orden], {
    encoding: 'utf8',
  }).trim();
}

try {
  // Se pide una copia fresca antes de bajarla: si el temporizador no corrió hoy
  // —el servidor pudo estar apagado—, bajaríamos la de ayer sin enterarnos.
  console.log('Generando copia fresca en el servidor…');
  console.log('  ' + enServidor('/opt/acostaresearch/respaldar.sh'));

  const ultimo = enServidor(
    "ls -1t /var/backups/acostaresearch/acostaresearch-*.tar.gz | head -1",
  );
  const nombre = path.basename(ultimo);

  fs.mkdirSync(DESTINO, { recursive: true });
  const local = path.join(DESTINO, nombre);

  console.log(`\nDescargando ${nombre}…`);
  execFileSync('scp', ['-q', '-o', 'BatchMode=yes', `acosta:${ultimo}`, local], {
    stdio: 'inherit',
  });

  const bytes = fs.statSync(local).size;
  console.log(`\nGuardado en  respaldos/${nombre}  (${(bytes / 1024 / 1024).toFixed(1)} MB)`);

  // Se listan las copias locales para que se vea de un vistazo cuántas hay y de
  // cuándo. Un respaldo del que nadie sabe la fecha no tranquiliza a nadie.
  const copias = fs
    .readdirSync(DESTINO)
    .filter((f) => f.endsWith('.tar.gz'))
    .sort()
    .reverse();

  console.log(`\nCopias en este equipo (${copias.length}):`);
  for (const c of copias.slice(0, 5)) {
    const kb = (fs.statSync(path.join(DESTINO, c)).size / 1024 / 1024).toFixed(1);
    console.log(`  ${c}  ${kb} MB`);
  }
  if (copias.length > 5) console.log(`  … y ${copias.length - 5} más`);
} catch (error) {
  console.error('\nNo se pudo traer el respaldo:', error.message.split('\n')[0]);
  console.error('Comprueba que `ssh acosta` funciona desde esta red.');
  process.exit(1);
}

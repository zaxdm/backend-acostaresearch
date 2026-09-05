'use strict';

/**
 * Sube las skills del catálogo a la Skills API de Anthropic.
 *
 * Es el paso que convierte «pendiente de publicar» en un capítulo utilizable:
 * la API devuelve un `skill_id`, se guarda en la tabla `skills`, y a partir de
 * ahí `redactar` puede invocarla.
 *
 * QUÉ SE SUBE Y QUÉ NO SALE DE AQUÍ
 * ---------------------------------
 * Se envía el bundle entero —SKILL.md y sus referencias— a la infraestructura
 * de Anthropic. Ese es justamente el punto del diseño: el contenido vive allí y
 * en este servidor, nunca en el Claude del comprador. Por el conector solo sale
 * el capítulo redactado.
 *
 * Uso:
 *   npm run skills:upload              → sube las que falten
 *   npm run skills:upload -- --todas   → vuelve a subir todas, creando versión nueva
 *   npm run skills:upload -- marco-teorico
 */

const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const Anthropic = require('@anthropic-ai/sdk');
const { toFile } = require('@anthropic-ai/sdk');

const env = require('../src/config/env');
const logger = require('../src/config/logger');
const prisma = require('../src/lib/prisma');
const skillBundle = require('../src/modules/skills/skill.bundle');

/** Límite de la API: 30 MB sin comprimir por skill. */
const MAX_BYTES = 30 * 1024 * 1024;

/**
 * Convierte el `.skill` (un ZIP) en la lista de ficheros que espera la API.
 *
 * El nombre de cada fichero conserva su ruta dentro del bundle
 * —`marco-teorico/references/antecedentes.md`—, porque la API exige que todos
 * cuelguen de un mismo directorio con SKILL.md en su raíz.
 */
async function ficherosDelBundle(rutaBundle) {
  const zip = new AdmZip(rutaBundle);
  const entradas = zip.getEntries().filter((entrada) => !entrada.isDirectory);

  const total = entradas.reduce((suma, entrada) => suma + entrada.header.size, 0);
  if (total > MAX_BYTES) {
    throw new Error(
      `${path.basename(rutaBundle)} pesa ${Math.round(total / 1024 / 1024)} MB sin comprimir ` +
        'y el máximo son 30 MB.',
    );
  }

  if (!entradas.some((entrada) => /(^|\/)SKILL\.md$/i.test(entrada.entryName))) {
    throw new Error(`${path.basename(rutaBundle)} no tiene SKILL.md en la raíz de su carpeta.`);
  }

  return Promise.all(
    entradas.map((entrada) => toFile(entrada.getData(), entrada.entryName)),
  );
}

async function subirUna(cliente, skill, { versionNueva }) {
  // La ficha guarda el nombre del archivo; la carpeta la pone este entorno.
  const rutaBundle = skillBundle.resolver(skill.bundlePath);

  if (!fs.existsSync(rutaBundle)) {
    throw new Error(`No se encuentra el bundle: ${rutaBundle}`);
  }

  const files = await ficherosDelBundle(rutaBundle);

  // Si ya estaba subida se crea una VERSIÓN nueva en vez de otra skill: así el
  // identificador no cambia y las licencias en uso no se enteran.
  if (versionNueva && skill.anthropicSkillId) {
    const version = await cliente.skills.versions.create(skill.anthropicSkillId, { files });
    return { anthropicSkillId: skill.anthropicSkillId, anthropicVersionId: version.id };
  }

  const creada = await cliente.skills.create({ files, display_name: skill.displayName });
  return { anthropicSkillId: creada.id, anthropicVersionId: creada.latest_version_id };
}

async function main() {
  if (!env.rewriteEnabled) {
    throw new Error(
      'Falta ANTHROPIC_API_KEY en el .env. Sin ella no se puede subir nada: ' +
        'créala en https://console.anthropic.com/settings/keys',
    );
  }

  const argumentos = process.argv.slice(2);
  const todas = argumentos.includes('--todas');
  const soloEstas = argumentos.filter((a) => !a.startsWith('--'));

  const cliente = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const skills = await prisma.skill.findMany({
    where: {
      active: true,
      ...(soloEstas.length > 0 ? { code: { in: soloEstas } } : {}),
      // Por defecto solo las que aún no se han subido; --todas fuerza el resto.
      ...(todas || soloEstas.length > 0 ? {} : { anthropicSkillId: null }),
    },
    orderBy: { orden: 'asc' },
  });

  if (skills.length === 0) {
    logger.info('No hay skills pendientes de subir. Usa --todas para publicar una versión nueva.');
    return;
  }

  const resultado = [];

  for (const skill of skills) {
    const kb = Math.round(skill.skillMdBytes / 1024);
    process.stdout.write(`  ${skill.displayName} (${kb} KB)… `);

    try {
      const ids = await subirUna(cliente, skill, { versionNueva: todas });
      await prisma.skill.update({ where: { code: skill.code }, data: ids });
      process.stdout.write(`${ids.anthropicSkillId}\n`);
      resultado.push({ code: skill.code, ...ids });
    } catch (error) {
      // Que falle una no debe impedir subir las demás: se anota y se sigue.
      process.stdout.write(`ERROR\n`);
      logger.error({ err: error, skill: skill.code }, 'No se pudo subir la skill');
    }
  }

  logger.info({ subidas: resultado.length, de: skills.length }, 'Subida terminada');

  const pendientes = await prisma.skill.count({
    where: { active: true, anthropicSkillId: null },
  });
  if (pendientes > 0) {
    logger.warn(`Quedan ${pendientes} skills sin publicar.`);
  }
}

main()
  .catch((error) => {
    logger.error({ err: error }, error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

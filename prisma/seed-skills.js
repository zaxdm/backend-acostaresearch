'use strict';

/**
 * Registra en la base de datos las 9 skills del método.
 *
 * Lee los bundles `.skill` de la carpeta `skills/` para sacar el nombre real del
 * frontmatter y el tamaño del SKILL.md, pero NO guarda el contenido: el
 * contenido vive en el bundle y, cuando se suba, en la Skills API de Anthropic.
 * Aquí solo queda el catálogo.
 *
 * Ejecutar con: npm run db:seed-skills
 */

const path = require('node:path');
const fs = require('node:fs');
const AdmZip = require('adm-zip');
const prisma = require('../src/lib/prisma');
const logger = require('../src/config/logger');

const CARPETA_SKILLS = process.env.SKILLS_DIR
  ? path.resolve(process.env.SKILLS_DIR)
  : path.resolve(__dirname, '../../skills');

/**
 * Las 9 en su orden real. El resumen es lo ÚNICO del contenido que verá el
 * comprador en el catálogo, así que está escrito para él y no copiado de la
 * descripción técnica del frontmatter (que además lleva los disparadores de
 * activación, que no le dicen nada).
 */
const METODO = [
  {
    archivo: 'tema-y-delimitacion.skill',
    displayName: '1 · Tema y delimitación',
    summary:
      'Elige, valida y delimita el tema. Sale con variables, población, año y un título tentativo listo para el asesor.',
  },
  {
    archivo: 'problema-y-objetivos.skill',
    displayName: '2 · Capítulo I · Problema y objetivos',
    summary:
      'Planteamiento, pregunta, objetivos, hipótesis y matriz de consistencia, a partir de tus fuentes.',
  },
  {
    archivo: 'marco-teorico.skill',
    displayName: '3 · Capítulo II · Marco teórico',
    summary: 'Antecedentes, bases teóricas y marco conceptual con citas APA 7 reales.',
  },
  {
    archivo: 'metodologia.skill',
    displayName: '4 · Capítulo III · Metodología',
    summary:
      'Tipo y diseño, población y muestra, operacionalización, ética y plan de análisis.',
  },
  {
    archivo: 'instrumento-investigacion.skill',
    displayName: '5 · Instrumento de recolección',
    summary:
      'Construye o adapta el instrumento: ítems, juicio de expertos con V de Aiken y pilotaje.',
  },
  {
    archivo: 'recoleccion-datos.skill',
    displayName: '6 · Trabajo de campo',
    summary:
      'Cartas, consentimientos, matriz de datos y bitácora para ejecutar la recolección.',
  },
  {
    archivo: 'analisis-datos-rstudio.skill',
    displayName: '7 · Capítulo IV · Resultados',
    summary:
      'Análisis estadístico paso a paso y redacción de resultados en APA 7, organizada por objetivos.',
  },
  {
    archivo: 'discusion.skill',
    displayName: '8 · Capítulo V · Discusión',
    summary: 'Contrasta cada hallazgo con la literatura del marco teórico, objetivo por objetivo.',
  },
  {
    archivo: 'conclusiones-abstract.skill',
    displayName: '9 · Capítulo VI · Conclusiones y resumen',
    summary: 'Conclusiones por objetivo, recomendaciones, resumen en español y abstract en inglés.',
  },
];

/** Saca el `name` del frontmatter y el tamaño del SKILL.md sin extraer nada a disco. */
function leerBundle(rutaBundle) {
  const zip = new AdmZip(rutaBundle);
  const entrada = zip.getEntries().find((e) => /(^|\/)SKILL\.md$/i.test(e.entryName));

  if (!entrada) {
    throw new Error(`El bundle ${path.basename(rutaBundle)} no tiene SKILL.md`);
  }

  const contenido = entrada.getData().toString('utf8');
  const frontmatter = contenido.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const nombre = frontmatter?.[1].match(/^name:\s*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, '');

  if (!nombre) {
    throw new Error(`El bundle ${path.basename(rutaBundle)} no declara "name" en el frontmatter`);
  }

  return { code: nombre, skillMdBytes: Buffer.byteLength(contenido, 'utf8') };
}

async function main() {
  if (!fs.existsSync(CARPETA_SKILLS)) {
    throw new Error(`No existe la carpeta de skills: ${CARPETA_SKILLS}`);
  }

  const resumen = [];

  for (const [indice, definicion] of METODO.entries()) {
    const ruta = path.join(CARPETA_SKILLS, definicion.archivo);

    if (!fs.existsSync(ruta)) {
      logger.warn({ archivo: definicion.archivo }, 'Bundle no encontrado: se omite');
      continue;
    }

    const { code, skillMdBytes } = leerBundle(ruta);

    // Se conservan los identificadores de Anthropic si ya se subió alguna vez:
    // volver a sembrar el catálogo no debe desconectar las skills en producción.
    await prisma.skill.upsert({
      where: { code },
      update: {
        orden: indice + 1,
        displayName: definicion.displayName,
        summary: definicion.summary,
        bundlePath: ruta,
        skillMdBytes,
        active: true,
      },
      create: {
        code,
        orden: indice + 1,
        displayName: definicion.displayName,
        summary: definicion.summary,
        bundlePath: ruta,
        skillMdBytes,
      },
    });

    resumen.push({ code, kb: Math.round(skillMdBytes / 1024) });
  }

  logger.info({ skills: resumen }, 'Catálogo de skills actualizado');
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'Falló el registro del catálogo de skills');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

'use strict';

/**
 * Repara lo que quedó mal en las bibliotecas de los tesistas antes de los
 * arreglos del 13 de septiembre de 2026.
 *
 * Esos arreglos impiden que vuelva a pasar, pero no tocan lo que ya estaba
 * guardado. Dos cosas:
 *
 *   · DUPLICADOS. La misma fuente dos veces en la biblioteca de alguien, por
 *     haber entrado por dos caminos —su Zotero y un DOI, o dos exports—. Sale
 *     repetida en cada búsqueda. Se queda una por DOI: la que esté citada en
 *     algún capítulo; si no lo está ninguna, la de Zotero; si no, la más antigua.
 *     NUNCA se borra una citada: su clave está escrita en un capítulo y borrarla
 *     la deja como «CITA SIN LOCALIZAR» en el Word. Si hay dos citadas, se
 *     quedan las dos.
 *
 *   · AUTORES. Las que se añadieron por DOI tomaban los autores de OpenAlex, que
 *     llegan como nombre entero, y salían «F. Larcker, D.» en la bibliografía.
 *     Se vuelven a pedir a Crossref, donde el editor los depositó ya separados.
 *     Solo se cambian si Crossref tiene autores y son distintos.
 *
 * Todo en serie y con pausas: la base aguanta cinco conexiones y Crossref es un
 * servicio ajeno y gratuito. No lanzar mientras corre un despliegue o la
 * sincronización nocturna de Zotero.
 *
 * Uso:
 *   npm run fuentes:reparar                          → muestra qué haría, sin tocar nada
 *   npm run fuentes:reparar -- --aplicar
 *   npm run fuentes:reparar -- --solo=duplicados     (o --solo=autores)
 */

const PAUSA_CROSSREF_MS = 300;

const esperar = (ms) => new Promise((resuelve) => setTimeout(resuelve, ms));

/**
 * De un grupo de fuentes con el mismo DOI, cuáles se borran.
 *
 * Pura a propósito, para poder probarla sin base: es la decisión que no puede
 * equivocarse.
 */
function queBorrar(grupo, citadas) {
  if (grupo.length < 2) return [];

  const citada = (f) => citadas.has(f.ref);
  const citadasDelGrupo = grupo.filter(citada);

  // Las citadas se quedan todas. Si hay alguna, se borran solo las demás.
  if (citadasDelGrupo.length > 0) return grupo.filter((f) => !citada(f));

  const orden = [...grupo].sort((a, b) => {
    if ((a.origin === 'ZOTERO') !== (b.origin === 'ZOTERO')) return a.origin === 'ZOTERO' ? -1 : 1;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });
  return orden.slice(1);
}

async function duplicados({ prisma, clavesCitadas, aplicar }) {
  const fuentes = await prisma.reference.findMany({
    where: { ownerUserId: { not: null }, doi: { not: null } },
    select: { id: true, ref: true, doi: true, ownerUserId: true, origin: true, createdAt: true, title: true },
    orderBy: { createdAt: 'asc' },
  });

  const grupos = new Map();
  for (const f of fuentes) {
    const clave = `${f.ownerUserId}|${f.doi.trim().toLowerCase()}`;
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(f);
  }

  const citadasDe = new Map();
  let borradas = 0;

  for (const grupo of grupos.values()) {
    if (grupo.length < 2) continue;

    const dueno = grupo[0].ownerUserId;
    if (!citadasDe.has(dueno)) citadasDe.set(dueno, new Set(await clavesCitadas(dueno)));

    const fuera = queBorrar(grupo, citadasDe.get(dueno));
    if (fuera.length === 0) continue;

    const queda = grupo.filter((f) => !fuera.includes(f)).map((f) => f.ref).join(', ');
    console.log(`  ${grupo[0].doi}  «${grupo[0].title.slice(0, 60)}»`);
    console.log(`     se queda ${queda} · se borra ${fuera.map((f) => f.ref).join(', ')}`);

    if (aplicar) {
      await prisma.reference.deleteMany({
        where: { id: { in: fuera.map((f) => f.id) }, ownerUserId: dueno },
      });
    }
    borradas += fuera.length;
  }

  return borradas;
}

async function autores({ prisma, crossref, normalizar, aplicar }) {
  const fuentes = await prisma.reference.findMany({
    where: { ownerUserId: { not: null }, sourceRef: { startsWith: 'doi:' }, doi: { not: null } },
    select: { id: true, doi: true, authors: true, title: true, source: true, year: true, abstract: true, tags: true },
  });

  let corregidas = 0;

  for (const fuente of fuentes) {
    const ficha = await crossref.porDoi(fuente.doi);
    await esperar(PAUSA_CROSSREF_MS);

    if (!ficha?.authors || ficha.authors === fuente.authors) continue;

    console.log(`  ${fuente.doi}\n     antes: ${fuente.authors}\n     ahora: ${ficha.authors}`);

    if (aplicar) {
      const authors = ficha.authors.slice(0, 500);
      await prisma.reference.update({
        where: { id: fuente.id },
        data: {
          authors,
          // La columna de búsqueda lleva los autores dentro: se rehace igual que al importar.
          busqueda: normalizar(
            [fuente.title, authors, fuente.source, fuente.year, fuente.abstract, fuente.tags]
              .filter(Boolean)
              .join(' '),
          ),
        },
      });
    }
    corregidas += 1;
  }

  return corregidas;
}

async function main() {
  const prisma = require('../src/lib/prisma');
  const logger = require('../src/config/logger');
  const crossref = require('../src/modules/references/crossref.client');
  const { normalizar } = require('../src/modules/references/zotero.mapper');
  const { clavesCitadas } = require('../src/modules/references/citadas');

  const aplicar = process.argv.includes('--aplicar');
  const solo = (process.argv.find((a) => a.startsWith('--solo=')) ?? '').split('=')[1] ?? null;

  try {
    if (!solo || solo === 'duplicados') {
      console.log('\n── Duplicados ──');
      const n = await duplicados({ prisma, clavesCitadas, aplicar });
      console.log(`  ${n} ${aplicar ? 'borradas' : 'se borrarían'}.`);
    }

    if (!solo || solo === 'autores') {
      console.log('\n── Autores ──');
      const n = await autores({ prisma, crossref, normalizar, aplicar });
      console.log(`  ${n} ${aplicar ? 'corregidas' : 'se corregirían'}.`);
    }

    if (!aplicar) console.log('\nNo se ha tocado nada. Para aplicarlo: npm run fuentes:reparar -- --aplicar');
  } catch (error) {
    logger.error({ err: error }, 'Falló la reparación de fuentes');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) main();

module.exports = { queBorrar };

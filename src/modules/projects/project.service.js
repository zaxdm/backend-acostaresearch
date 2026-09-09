'use strict';

/**
 * La memoria del proyecto del tesista.
 *
 * El conector respondía y olvidaba. Cada conversación empezaba de cero, y el
 * tesista volvía a contar su tema, sus objetivos y su metodología; si abría un
 * chat nuevo, había perdido el hilo. Esto es lo que hace que «sigue con mi
 * tesis» signifique algo.
 *
 * Lo que se guarda es lo ACORDADO, no el texto. Dos o tres frases por capítulo:
 * qué quedó decidido. El documento es otra etapa y otro problema, y confundir
 * las dos cosas convertiría esto en un almacén de párrafos que nadie relee.
 */

const projectRepository = require('./project.repository');
const skillService = require('../skills/skill.service');
const { guardarAvanceSchema } = require('./project.schema');

/** Cómo se ve cada estado en el texto que recibe el asistente. */
const MARCAS = {
  LISTO: '[hecho]',
  EN_CURSO: '[en curso]',
  PENDIENTE: '[pendiente]',
};

/**
 * Lo que el asistente lee sobre el proyecto, en texto plano.
 *
 * Va dentro de la respuesta de las herramientas en lugar de esperar a que el
 * asistente decida consultarlo. Delegar en que se acuerde de preguntar es
 * justo lo que no funciona: no se acuerda, y el tesista repite su tema por
 * cuarta vez.
 *
 * Devuelve null cuando no hay nada que contar, para no meter un bloque vacío en
 * cada respuesta.
 */
async function contexto(userId, productCode) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  if (!proyecto) return null;

  const porCapitulo = new Map(proyecto.stages.map((e) => [e.skillCode, e]));
  const hayAvance = proyecto.tema || proyecto.stages.some((e) => e.estado !== 'PENDIENTE');
  if (!hayAvance) return null;

  const cabecera = [];
  if (proyecto.tema) cabecera.push(`Tema: ${proyecto.tema}`);
  const donde = [proyecto.carrera, proyecto.universidad].filter(Boolean).join(' · ');
  if (donde) cabecera.push(donde);

  // Se recorre el catálogo y no las etapas guardadas, para que los capítulos
  // que aún no ha tocado también salgan. Saber lo que falta es la mitad de
  // saber por dónde va.
  const catalogo = await skillService.listCatalog(productCode);
  const lineas = [];

  for (const skill of catalogo) {
    const etapa = porCapitulo.get(skill.code);
    const estado = etapa?.estado ?? 'PENDIENTE';
    lineas.push(`${MARCAS[estado]} ${skill.displayName}  (clave: ${skill.code})`);
    if (etapa?.resumen) lineas.push(`      quedó así: ${etapa.resumen}`);
  }

  return [
    'LO QUE ESTE SERVIDOR YA SABE DE SU PROYECTO',
    ...cabecera,
    '',
    ...lineas,
    '',
    'Da esto por sabido: NO se lo vuelvas a preguntar. Si algo de aquí ya no es ' +
      'cierto porque lo han cambiado hablando, corrígelo con "guardar_avance".',
  ].join('\n');
}

/**
 * Guarda lo que quedó decidido.
 *
 * Crea el proyecto si hacía falta: se crea cuando hay algo que recordar, no al
 * comprar. Una fila vacía por comprador solo serviría para no poder distinguir
 * «no ha empezado» de «no ha comprado».
 */
async function guardarAvance({ userId, productCode, ...entrada }) {
  const datos = guardarAvanceSchema.parse(entrada);

  const proyecto = await projectRepository.asegurar(userId, productCode, datos);

  let etapa = null;
  if (datos.capitulo) {
    etapa = await projectRepository.guardarEtapa(proyecto.id, datos.capitulo, {
      estado: datos.estado,
      resumen: datos.resumen,
    });
  }

  return { proyecto, etapa };
}

/**
 * Qué toca ahora, si se puede saber.
 *
 * El primer capítulo del catálogo que no esté LISTO. No adivina más allá de
 * eso: el orden del método es una recomendación, y un tesista que salte al
 * capítulo III porque su asesor se lo pidió no está haciéndolo mal.
 */
async function siguientePaso(userId, productCode) {
  const [proyecto, catalogo] = await Promise.all([
    projectRepository.buscar(userId, productCode),
    skillService.listCatalog(productCode),
  ]);

  if (catalogo.length === 0) return null;

  const listos = new Set(
    (proyecto?.stages ?? []).filter((e) => e.estado === 'LISTO').map((e) => e.skillCode),
  );

  return catalogo.find((s) => !listos.has(s.code)) ?? null;
}

/**
 * Los proyectos del comprador, ya cruzados con el catálogo.
 *
 * El cruce se hace aquí y no en la web a propósito: la web no tiene por qué
 * saber qué capítulos trae cada método ni en qué orden van, y hacerle pedir dos
 * cosas para pintar una sola pantalla es cómo se acaba enseñando una lista
 * incompleta mientras carga la otra.
 */
async function deUsuario(userId) {
  const proyectos = await projectRepository.listarDeUsuario(userId);

  return Promise.all(
    proyectos.map(async (proyecto) => {
      const catalogo = await skillService.listCatalog(proyecto.productCode);
      const porCapitulo = new Map(proyecto.stages.map((e) => [e.skillCode, e]));

      const etapas = catalogo.map((skill) => {
        const etapa = porCapitulo.get(skill.code);
        return {
          code: skill.code,
          displayName: skill.displayName,
          estado: etapa?.estado ?? 'PENDIENTE',
          resumen: etapa?.resumen ?? null,
          updatedAt: etapa?.updatedAt ?? null,
        };
      });

      const listos = etapas.filter((e) => e.estado === 'LISTO').length;

      return {
        id: proyecto.id,
        productCode: proyecto.productCode,
        tema: proyecto.tema,
        carrera: proyecto.carrera,
        universidad: proyecto.universidad,
        updatedAt: proyecto.updatedAt,
        etapas,
        avance: { listos, total: etapas.length },
        // El primero que no esté dado por bueno. Nulo cuando ya no queda
        // ninguno, que es lo que distingue «terminó» de «no ha empezado».
        siguiente: etapas.find((e) => e.estado !== 'LISTO') ?? null,
      };
    }),
  );
}

module.exports = { contexto, guardarAvance, siguientePaso, deUsuario };

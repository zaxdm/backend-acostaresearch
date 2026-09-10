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

const logger = require('../../config/logger');
const projectRepository = require('./project.repository');
const almacen = require('./project.storage');
const documento = require('./project.docx');
const citas = require('./project.citas');
const bibtex = require('./project.bibtex');
const etapas = require('./project.etapas');
const evidencia = require('./project.evidencia');
const plantilla = require('./project.plantilla');
const auditoria = require('./project.auditoria');
const skillService = require('../skills/skill.service');
const referenceService = require('../references/reference.service');
const { guardarAvanceSchema, guardarCapituloSchema } = require('./project.schema');

/** Cómo se ve cada estado en el texto que recibe el asistente. */
const MARCAS = {
  LISTO: '[hecho]',
  EN_CURSO: '[en curso]',
  PENDIENTE: '[pendiente]',
};

/**
 * El capítulo donde se reportan los resultados, en cada método.
 *
 * Es donde cae el análisis que llega de la página de R: el tesista no elige
 * capítulo, porque solo hay uno donde tiene sentido. Se busca en el catálogo del
 * producto en vez de casar producto y clave a mano, para que un método nuevo
 * que use cualquiera de las dos funcione sin tocar esto.
 */
const CAPITULOS_DE_RESULTADOS = ['analisis-datos-rstudio', 'articulo-fase5-resultados'];

async function capituloDeResultados(productCode) {
  const catalogo = await skillService.listCatalog(productCode);
  const claves = new Set(catalogo.map((skill) => skill.code));
  return CAPITULOS_DE_RESULTADOS.find((clave) => claves.has(clave)) ?? null;
}

/**
 * El aviso de que hay un análisis que el asistente todavía no ha leído.
 *
 * Guardado no sirve de nada si Claude no se entera, y no se va a enterar solo:
 * no pregunta por lo que no sabe que existe. Así que va en el bloque que lee al
 * empezar cada conversación.
 *
 * Se calla en cuanto hay cifras guardadas en ese capítulo, que es la señal de
 * que alguien ya lo leyó y sacó los números. Y no dice de dónde vino el
 * análisis: puede haber llegado de la web o pegado desde RStudio, y en los dos
 * casos lo que falta es lo mismo.
 */
async function avisoDeAnalisis(proyecto, porCapitulo) {
  for (const capitulo of CAPITULOS_DE_RESULTADOS) {
    const cifras = porCapitulo.get(capitulo)?.datos?.resultados ?? [];
    if (cifras.length > 0) continue;

    let fecha = null;
    try {
      fecha = await almacen.fechaDeAnalisis(proyecto.id, capitulo);
    } catch {
      // Un aviso que no se puede comprobar no puede tumbar «mi_proyecto».
      continue;
    }
    if (!fecha) continue;

    return (
      'HAY UN ANÁLISIS SIN LEER: el tesista guardó su script de R y la salida de la consola ' +
      `(${fecha.toISOString().slice(0, 10)}), y todavía no se han sacado sus cifras. Léelo ` +
      'con "ver_analisis" ANTES de redactar los resultados, y guarda las cifras que vayan al ' +
      'texto con "guardar_analisis".'
    );
  }
  return null;
}

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
  // El aviso cuenta como avance: quien solo ha mandado su análisis desde la web
  // tiene un proyecto sin tema ni capítulos, y sin esto el bloque saldría vacío
  // y el aviso con él.
  const aviso = await avisoDeAnalisis(proyecto, porCapitulo);
  const hayAvance = proyecto.tema || proyecto.stages.some((e) => e.estado !== 'PENDIENTE');
  if (!hayAvance && !aviso) return null;

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
    // Los campos van antes que el resumen: son lo exacto, y el resumen es el
    // matiz. Al revés, el asistente lee la prosa primero y ya no mira el dato.
    lineas.push(...etapas.comoTexto(skill.code, etapa?.datos));
    if (etapa?.resumen) lineas.push(`      quedó así: ${etapa.resumen}`);
  }

  return [
    'LO QUE ESTE SERVIDOR YA SABE DE SU PROYECTO',
    ...cabecera,
    '',
    ...lineas,
    '',
    ...(aviso ? [aviso, ''] : []),
    'Da esto por sabido: NO se lo vuelvas a preguntar. Si algo de aquí ya no es ' +
      'cierto porque lo han cambiado hablando, corrígelo con "guardar_avance".',
  ].join('\n');
}

/**
 * Los datos de cada etapa, con el tema del proyecto puesto donde corresponde.
 *
 * El tema vive en dos sitios y son el mismo dato: `Project.tema`, que es lo que
 * se enseña arriba de todo y en el panel, y el campo `tema` de la etapa de
 * delimitación. Sin unirlos aquí, un tesista que ya dijo su tema recibía
 * «falta fijar Tema delimitado», que es sencillamente falso y le haría
 * responder algo que ya había respondido.
 *
 * Se une al leer y no al escribir a propósito: dos copias del mismo dato acaban
 * discrepando, y entonces hay que decidir cuál manda.
 */
function datosPorEtapa(proyecto) {
  const porEtapa = new Map(proyecto.stages.map((e) => [e.skillCode, e.datos ?? {}]));

  if (proyecto.tema) {
    const delimitacion = porEtapa.get('tema-y-delimitacion') ?? {};
    porEtapa.set('tema-y-delimitacion', { tema: proyecto.tema, ...delimitacion });
  }

  return porEtapa;
}

/**
 * El aviso de que a un capítulo le faltan cosas de los anteriores.
 *
 * Se comprueba al empezar el capítulo, que es el único momento en que sirve de
 * algo: después, el tesista ya ha escrito. Devuelve null cuando no falta nada, y
 * también cuando esa etapa no declara requisitos — no se inventan.
 */
async function loQueFalta(userId, productCode, skillCode) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  if (!proyecto) return null;

  const faltan = etapas.queFalta(skillCode, datosPorEtapa(proyecto));
  if (faltan.length === 0) return null;

  return (
    `ANTES DE REDACTAR: falta fijar ${faltan.join(', ')}.\n` +
    'Eso viene de un capítulo anterior y este se apoya en ello. Pregúntaselo al tesista y ' +
    'guárdalo con "guardar_avance" antes de seguir. Si redactáis sin eso, el capítulo no ' +
    'va a cuadrar con los de antes y habrá que rehacerlo.'
  );
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
  let camposGuardados = [];

  if (datos.capitulo) {
    /**
     * Los datos sueltos se fusionan con los que ya había.
     *
     * Un asistente que corrige los objetivos específicos no puede borrar de
     * paso el problema general solo porque esa llamada no lo mencionaba. Es la
     * misma regla que gobierna el resto de la memoria.
     */
    const actual = await projectRepository.buscar(userId, productCode);
    const previa = (actual?.stages ?? []).find((e) => e.skillCode === datos.capitulo);

    let paraGuardar;
    const limpio = etapas.limpiar(datos.capitulo, datos.datos);

    if (limpio) {
      paraGuardar = etapas.fusionar(previa?.datos, limpio);
      camposGuardados = Object.keys(limpio);
    }

    /**
     * Anotar algo de un capítulo lo pone en curso.
     *
     * Un capítulo con el tema, la población y el periodo ya fijados no está
     * «sin empezar», y el panel diciendo que sí es sencillamente falso. Sube
     * solo desde PENDIENTE: no rebaja un capítulo cerrado, y no pisa el estado
     * que venga dicho a propósito en esta misma llamada.
     */
    const anota = Boolean(limpio || datos.resumen);
    const arranca = anota && !datos.estado && (previa?.estado ?? 'PENDIENTE') === 'PENDIENTE';

    etapa = await projectRepository.guardarEtapa(proyecto.id, datos.capitulo, {
      estado: datos.estado ?? (arranca ? 'EN_CURSO' : undefined),
      resumen: datos.resumen,
      datos: paraGuardar,
    });
  }

  return { proyecto, etapa, camposGuardados };
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
 * Guarda el texto de un capítulo.
 *
 * El texto va a disco y en la base solo queda cuánto ocupa y de cuándo es. Ver
 * `project.storage` para el porqué.
 */
async function guardarCapitulo({ userId, productCode, ...entrada }) {
  const datos = guardarCapituloSchema.parse(entrada);

  const proyecto = await projectRepository.asegurar(userId, productCode);
  const { palabras } = await almacen.guardar(proyecto.id, datos.capitulo, datos.texto, {
    anadir: datos.anadir === true,
  });

  // El capítulo pasa a EN_CURSO por escribir en él, pero nunca a LISTO: darlo
  // por bueno es del tesista. Y si ya estaba LISTO no se rebaja, porque volver
  // a tocar un capítulo cerrado para corregir una coma no lo reabre.
  const etapaActual = await projectRepository.buscar(userId, productCode);
  const previa = (etapaActual?.stages ?? []).find((e) => e.skillCode === datos.capitulo);

  const etapa = await projectRepository.guardarEtapa(proyecto.id, datos.capitulo, {
    estado: previa?.estado === 'LISTO' ? undefined : 'EN_CURSO',
    palabras,
    textoAt: new Date(),
  });

  return { palabras: etapa.palabras ?? palabras };
}

/**
 * El Word con todo lo escrito hasta ahora.
 *
 * Solo entran los capítulos que tienen texto, en el orden del método. Devuelve
 * null si no hay ni uno: un documento con la portada y nada más parece un fallo
 * del servidor y no lo es.
 */
async function armarWord(userId, productCode) {
  const [proyecto, catalogo, nombre] = await Promise.all([
    projectRepository.buscar(userId, productCode),
    skillService.listCatalog(productCode),
    projectRepository.nombreDe(userId),
  ]);

  if (!proyecto) return null;

  const conTexto = new Set(
    proyecto.stages.filter((e) => (e.palabras ?? 0) > 0).map((e) => e.skillCode),
  );

  const capitulos = [];
  for (const skill of catalogo) {
    if (!conTexto.has(skill.code)) continue;
    const texto = await almacen.leer(proyecto.id, skill.code);
    if (texto && texto.trim() !== '') {
      capitulos.push({ titulo: skill.displayName, texto });
    }
  }

  if (capitulos.length === 0) return null;

  /**
   * Las citas se resuelven ahora, no al escribir el capítulo.
   *
   * Así, si una ficha se corrige en Zotero —el año que estaba mal, el DOI que
   * faltaba—, la siguiente descarga sale corregida en el texto Y en la lista de
   * referencias a la vez. Guardar la cita ya montada dentro del capítulo
   * congelaría el error para siempre.
   */
  const claves = [...new Set(capitulos.flatMap((c) => citas.clavesDe(c.texto)))];
  const fuentes = await referenceService.porClaves(claves, userId);
  const porClave = new Map(fuentes.map((f) => [f.ref, f]));

  const usadas = new Map();
  const perdidas = new Set();

  for (const capitulo of capitulos) {
    const resuelto = citas.resolver(capitulo.texto, porClave);
    capitulo.texto = resuelto.texto;
    for (const [clave, fuente] of resuelto.usadas) usadas.set(clave, fuente);
    for (const clave of resuelto.perdidas) perdidas.add(clave);
  }

  if (perdidas.size > 0) {
    // No se corta la descarga: el tesista tiene derecho a su documento aunque
    // una cita esté mal. Pero queda anotado, y en el Word se ve.
    logger.warn(
      { userId, productCode, perdidas: [...perdidas] },
      'Citas del Word que no corresponden a ninguna fuente',
    );
  }

  // Los estilos de su facultad, si los subió. Sin ellos sale el formato de
  // tesis por defecto, que es lo que había hasta ahora.
  const estilos = await almacen.leerPlantilla(proyecto.id).catch(() => null);

  const buffer = await documento.armar({
    tema: proyecto.tema,
    carrera: proyecto.carrera,
    universidad: proyecto.universidad,
    nombre,
    capitulos,
    referencias: citas.bibliografia([...usadas.values()]),
    estilos,
  });

  return {
    buffer,
    nombreArchivo: documento.nombreDeArchivo(proyecto.tema),
    capitulos: capitulos.length,
    referencias: usadas.size,
    citasPerdidas: [...perdidas],
  };
}

/**
 * La bibliografía en BibTeX, para quien escribe en LaTeX.
 *
 * SALE DE LAS MISMAS CITAS QUE EL WORD, y eso es lo que garantiza que las dos
 * salidas no puedan discrepar: se leen las claves de los capítulos, se resuelven
 * contra las fuentes y se escribe lo que se usó. Ni una fuente de más —una
 * bibliografía con lo que no se citó es un error de bulto— ni una de menos.
 *
 * Devuelve null cuando no hay ni una cita resuelta. Un `.bib` vacío compila y no
 * imprime nada, así que el tesista descubriría el problema al final, mirando una
 * bibliografía en blanco sin saber por qué.
 */
async function armarBibtex(userId, productCode) {
  const [proyecto, catalogo] = await Promise.all([
    projectRepository.buscar(userId, productCode),
    skillService.listCatalog(productCode),
  ]);

  if (!proyecto) return null;

  const conTexto = new Set(
    proyecto.stages.filter((e) => (e.palabras ?? 0) > 0).map((e) => e.skillCode),
  );

  const textos = [];
  for (const skill of catalogo) {
    if (!conTexto.has(skill.code)) continue;
    const texto = await almacen.leer(proyecto.id, skill.code);
    if (texto && texto.trim() !== '') textos.push(texto);
  }

  const claves = [...new Set(textos.flatMap((texto) => citas.clavesDe(texto)))];
  if (claves.length === 0) return null;

  const fuentes = await referenceService.porClaves(claves, userId);
  if (fuentes.length === 0) return null;

  // Las claves que no resuelven se anotan pero no cortan la descarga: es el
  // mismo criterio que el Word, donde salen como «CITA SIN LOCALIZAR». Aquí no
  // se pueden marcar dentro del archivo —un `.bib` no tiene dónde— así que se
  // devuelven aparte para que quien llame decida cómo decirlo.
  const encontradas = new Set(fuentes.map((f) => f.ref));
  const perdidas = claves.filter((clave) => !encontradas.has(clave));

  if (perdidas.length > 0) {
    logger.warn({ userId, productCode, perdidas }, 'Citas sin fuente al armar el BibTeX');
  }

  return {
    contenido: bibtex.armar(fuentes),
    nombreArchivo: documento.nombreDeArchivo(proyecto.tema).replace(/\.docx$/i, '.bib'),
    referencias: fuentes.length,
    citasPerdidas: perdidas,
  };
}

/**
 * Qué sostiene cada afirmación de la tesis.
 *
 * Lee los capítulos escritos y devuelve, por cada uno, qué se afirma con fuente
 * y qué se afirma sin ella. `capitulo` acota a uno solo; sin él se revisa todo
 * lo escrito.
 */
async function revisarEvidencia(userId, productCode, { capitulo = null } = {}) {
  const [proyecto, catalogo] = await Promise.all([
    projectRepository.buscar(userId, productCode),
    skillService.listCatalog(productCode),
  ]);

  if (!proyecto) return null;

  const conTexto = new Set(
    proyecto.stages.filter((e) => (e.palabras ?? 0) > 0).map((e) => e.skillCode),
  );

  const capitulos = [];
  for (const skill of catalogo) {
    if (!conTexto.has(skill.code)) continue;
    if (capitulo && skill.code !== capitulo) continue;

    const texto = await almacen.leer(proyecto.id, skill.code);
    if (texto && texto.trim() !== '') capitulos.push({ titulo: skill.displayName, texto });
  }

  if (capitulos.length === 0) return null;

  // Se buscan las fuentes para poder decir CUÁL respalda cada afirmación, no
  // solo que hay una. «Respaldado por la clave AR97D22F86» no le dice nada a
  // nadie; «respaldado por Tinto (1975)» sí.
  const claves = [...new Set(capitulos.flatMap((c) => citas.clavesDe(c.texto)))];
  const fuentes = await referenceService.porClaves(claves, userId);
  const porClave = new Map(fuentes.map((f) => [f.ref, f]));

  return evidencia.revisar(capitulos, porClave);
}

/**
 * Guarda la plantilla de la facultad del tesista.
 *
 * Del .docx solo se queda la hoja de estilos. Ver `project.plantilla` para el
 * porqué: lo que no se guarda no se puede filtrar, y esos archivos suelen venir
 * con la tesis de otro dentro.
 */
async function guardarPlantilla({ userId, productCode, buffer, nombre }) {
  const xml = plantilla.extraerEstilos(buffer);

  const proyecto = await projectRepository.asegurar(userId, productCode);
  await almacen.guardarPlantilla(proyecto.id, xml);
  await projectRepository.marcarPlantilla(proyecto.id, nombre ?? null);

  return { estilos: plantilla.estilosQueTrae(xml) };
}

async function quitarPlantilla(userId, productCode) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  if (!proyecto) return false;

  await almacen.borrarPlantilla(proyecto.id);
  await projectRepository.marcarPlantilla(proyecto.id, null);
  return true;
}

/**
 * Guarda el análisis: el script, lo que devolvió, y las cifras.
 *
 * NO SE EJECUTA NADA AQUÍ, y es a propósito. El tesista corre su análisis en su
 * propio RStudio, con sus datos, y pega el resultado. Ejecutar R de terceros en
 * este servidor sería un problema de seguridad, no una función.
 *
 * Lo que aporta guardarlo: el script queda para poder responder, dentro de un
 * año, «¿de dónde salió este 0,42?», y las cifras quedan para que el repaso
 * pueda comprobar que ningún número del capítulo se escribió solo.
 */
async function guardarAnalisis({ userId, productCode, capitulo, script, salida, resultados }) {
  const proyecto = await projectRepository.asegurar(userId, productCode);

  const escritos = await almacen.guardarAnalisis(proyecto.id, capitulo, { script, salida });

  let guardadas = 0;
  if (Array.isArray(resultados) && resultados.length > 0) {
    const actual = await projectRepository.buscar(userId, productCode);
    const previa = (actual?.stages ?? []).find((e) => e.skillCode === capitulo);
    const limpio = etapas.limpiar(capitulo, { resultados });

    if (limpio?.resultados) {
      await projectRepository.guardarEtapa(proyecto.id, capitulo, {
        datos: etapas.fusionar(previa?.datos, limpio),
        estado: (previa?.estado ?? 'PENDIENTE') === 'PENDIENTE' ? 'EN_CURSO' : undefined,
      });
      guardadas = limpio.resultados.length;
    }
  }

  return { escritos, guardadas };
}

/**
 * El análisis que el tesista manda desde la página de R.
 *
 * Es `guardarAnalisis` con dos diferencias. El capítulo lo decide el método,
 * no quien lo manda. Y no llegan cifras: la web no sabe cuáles de todos los
 * números de la consola van al texto —eso lo decide Claude al leerlo, y las
 * guarda él—.
 *
 * Quién puede mandarlo NO se comprueba aquí sino en la ruta, contra sus
 * licencias. Este servicio no carga el de licencias a propósito: lo usan una
 * docena de pruebas que no tienen base de datos.
 */
async function recibirAnalisis({ userId, productCode, script, salida }) {
  const capitulo = await capituloDeResultados(productCode);
  if (!capitulo) return null;

  const { escritos } = await guardarAnalisis({ userId, productCode, capitulo, script, salida });
  return { capitulo, escritos };
}

/**
 * El análisis guardado de un capítulo, para dárselo al asistente.
 *
 * Sin capítulo, el de resultados del método, que es donde cae lo que llega de
 * la web. Van también las cifras ya guardadas, para que sepa qué le falta por
 * sacar y no vuelva a guardar las que ya estaban.
 *
 * Devuelve null si no hay nada: un análisis vacío presentado como tal invitaría
 * a redactar resultados sin números.
 */
async function leerAnalisis(userId, productCode, capitulo) {
  const clave = capitulo || (await capituloDeResultados(productCode));
  if (!clave) return null;

  const proyecto = await projectRepository.buscar(userId, productCode);
  if (!proyecto) return null;

  const [script, salida] = await Promise.all([
    almacen.leerAnalisis(proyecto.id, clave, 'script'),
    almacen.leerAnalisis(proyecto.id, clave, 'salida'),
  ]);
  if (!script && !salida) return null;

  const etapa = proyecto.stages.find((e) => e.skillCode === clave);
  return { capitulo: clave, script, salida, cifras: etapa?.datos?.resultados ?? [] };
}

/**
 * El repaso completo antes de entregar.
 *
 * Reúne en un sitio lo que ya saben los otros módulos —qué está escrito, qué
 * campos hay, qué citas resuelven, qué afirmaciones tienen respaldo— y coteja la
 * tesis consigo misma. No lee la tesis: la compara con lo que ella misma dice
 * que iba a hacer.
 */
async function auditar(userId, productCode) {
  const [proyecto, catalogo] = await Promise.all([
    projectRepository.buscar(userId, productCode),
    skillService.listCatalog(productCode),
  ]);

  if (!proyecto) return null;

  const conTexto = new Set(
    proyecto.stages.filter((e) => (e.palabras ?? 0) > 0).map((e) => e.skillCode),
  );

  const capitulos = [];
  for (const skill of catalogo) {
    if (!conTexto.has(skill.code)) continue;
    const texto = await almacen.leer(proyecto.id, skill.code);
    if (texto && texto.trim() !== '') {
      capitulos.push({ code: skill.code, titulo: skill.displayName, texto });
    }
  }

  const claves = [...new Set(capitulos.flatMap((c) => citas.clavesDe(c.texto)))];
  const fuentes = await referenceService.porClaves(claves, userId);
  const porClave = new Map(fuentes.map((f) => [f.ref, f]));
  const citasRotas = claves.filter((clave) => !porClave.has(clave));

  const informe =
    capitulos.length > 0 ? evidencia.revisar(capitulos, porClave) : { capitulos: [], total: {} };

  // A cada etapa se le adjunta lo que le falta de las anteriores, para que la
  // auditoría no tenga que volver a saber cómo se calcula eso.
  const porEtapa = datosPorEtapa(proyecto);
  const conFaltas = proyecto.stages.map((e) => ({
    ...e,
    faltan: etapas.queFalta(e.skillCode, porEtapa),
  }));

  return auditoria.auditar({
    proyecto,
    catalogo,
    etapas: conFaltas,
    capitulos,
    evidencia: informe,
    citasRotas,
  });
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
          palabras: etapa?.palabras ?? 0,
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
        plantilla: proyecto.plantillaAt
          ? { nombre: proyecto.plantillaNombre, desde: proyecto.plantillaAt }
          : null,
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

module.exports = {
  contexto,
  loQueFalta,
  guardarAvance,
  guardarCapitulo,
  armarWord,
  armarBibtex,
  revisarEvidencia,
  guardarAnalisis,
  recibirAnalisis,
  leerAnalisis,
  guardarPlantilla,
  quitarPlantilla,
  auditar,
  siguientePaso,
  deUsuario,
};

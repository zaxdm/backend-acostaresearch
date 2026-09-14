'use strict';

/**
 * R en la conversación: lo que hay entre la herramienta `trabajar_en_r` y el
 * motor.
 *
 * El tesista no toca código. Claude le pregunta qué necesita, corre el análisis
 * con esta herramienta y le explica el resultado; lo único que hace el tesista
 * es subir su archivo desde un enlace. Cada ejecución se guarda en el análisis
 * del proyecto, donde ya la leían `ver_analisis` y el repaso de cifras: para el
 * resto del conector da igual que el análisis venga de aquí o de RStudio.
 */

const path = require('node:path');

const env = require('../../config/env');
const logger = require('../../config/logger');
const projectRepository = require('../projects/project.repository');
const projectService = require('../projects/project.service');
const referenceService = require('../references/reference.service');
const citas = require('../projects/project.citas');
const csl = require('../projects/project.csl');
const cifras = require('../projects/project.cifras');
const normas = require('../projects/project.normas');
const formato = require('./r.formato');
const filtro = require('./r.filtro');
const catalogo = require('./r.catalogo');
const enlaces = require('./r.enlaces');
const informeWord = require('./r.informe');
const {
  crearMotor,
  conductorSystemd,
  conductorLocal,
  MotorNoDisponible,
  MotorOcupado,
} = require('./r.motor');

const RUNNER = path.resolve(__dirname, '../../../r/ejecutar.R');

/** Lo más que se guarda de guion y de consola en el proyecto: el techo de guardar_analisis. */
const MAXIMO_ANALISIS = 30000;

const N = '\n';

const NO_DISPONIBLE =
  'El análisis en R no está disponible ahora mismo en el servidor. No se ejecutó nada. ' +
  'Díselo al tesista con normalidad y ofrécele seguir con otra parte de su tesis; si lo ' +
  'necesita ya, puede correr el análisis en su RStudio y pegarte la salida.';

let motor = null;
let forzado = null;

function motorActual() {
  if (forzado) return forzado;
  if (env.rMotor === 'apagado') return null;

  if (!motor) {
    const limiteSegundos = env.R_LIMITE_SEGUNDOS;
    motor = crearMotor({
      carpetaBase: env.rSesionesDir,
      conductor:
        env.rMotor === 'systemd'
          ? conductorSystemd({ limiteSegundos })
          : conductorLocal({ rscript: env.RSCRIPT, runner: RUNNER, limiteSegundos }),
      limiteSegundos,
      maxSimultaneas: env.R_MAX_SIMULTANEAS,
    });
  }
  return motor;
}

/** Solo para las pruebas: un motor concreto, aunque la configuración diga apagado. */
function usarMotor(otro) {
  forzado = otro;
}

function disponible() {
  return motorActual() !== null;
}

function texto(contenido) {
  return { content: [{ type: 'text', text: contenido }] };
}

// ── Cómo se le cuenta a Claude ──────────────────────────────────────────────

const CLASES = {
  numeric: 'número',
  integer: 'entero',
  character: 'texto',
  factor: 'categorías',
  logical: 'sí/no',
  Date: 'fecha',
};

function peso(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

/** «120 x 14» → { filas: 120, columnas: 14 }. */
function dimensiones(objetos) {
  const datos = objetos.find((o) => o.nombre === 'datos' && /^\d+ x \d+$/.test(o.detalle));
  if (!datos) return null;
  const [filas, columnas] = datos.detalle.split(' x ').map(Number);
  return { filas, columnas };
}

/**
 * Lo que hay en la sesión, en texto. Solo ESTRUCTURA: ningún valor de ninguna
 * persona. Es el «término medio»: Claude sabe con qué trabaja sin ver la matriz.
 */
function describirEstado({ objetos = [], columnas = [], archivos = [] }) {
  const partes = [];
  const dim = dimensiones(objetos);

  if (columnas.length > 0) {
    const cabecera = dim
      ? `DATOS (solo su estructura): \`datos\`, ${dim.filas} filas × ${dim.columnas} columnas`
      : 'DATOS (solo su estructura): `datos`';
    const lineas = columnas.slice(0, 80).map((c) => {
      const clase = CLASES[c.clase] ?? c.clase;
      const detalle = [];
      if (c.resumen) {
        detalle.push(
          /^\d+$/.test(c.resumen) && clase !== 'número' && clase !== 'entero'
            ? `${c.resumen} valores distintos`
            : `de ${c.resumen.replace(' ', ' a ')}`,
        );
      }
      if (c.perdidos > 0) detalle.push(`${c.perdidos} perdidos`);
      return `  · ${c.nombre} — ${clase}${detalle.length > 0 ? `, ${detalle.join(', ')}` : ''}`;
    });
    if (columnas.length > 80) lineas.push(`  … y ${columnas.length - 80} columnas más`);
    partes.push([cabecera, ...lineas].join(N));
  }

  const otros = objetos.filter((o) => o.nombre !== 'datos');
  if (otros.length > 0) {
    const lista = otros
      .slice(0, 40)
      .map((o) => `${o.nombre} (${o.clase}${o.detalle && o.clase !== 'function' ? `, ${o.detalle}` : ''})`);
    if (otros.length > 40) lista.push(`y ${otros.length - 40} más`);
    partes.push(`OTROS OBJETOS: ${lista.join(', ')}`);
  }

  if (archivos.length > 0) {
    partes.push(
      `ARCHIVOS QUE SE PUEDEN BAJAR (con descargar): ${archivos.map((a) => `${a.nombre} (${peso(a.bytes)})`).join(', ')}`,
    );
  }

  return partes.join(`${N}${N}`);
}

/** La consola, recortada por el medio si es larga: el principio y el error del final son lo que importa. */
function recortarConsola(salida) {
  const lineas = String(salida ?? '').replace(/\s+$/, '').split('\n');
  const partes =
    lineas.length > 220
      ? [...lineas.slice(0, 150), `[… ${lineas.length - 210} líneas omitidas …]`, ...lineas.slice(-60)]
      : lineas;

  let unido = partes.join(N);
  if (unido.length > 12000) {
    unido = `${unido.slice(0, 8000)}${N}[… recortado …]${N}${unido.slice(-3500)}`;
  }
  return unido;
}

const RESULTADOS = {
  ok: null,
  error:
    'R SE PARÓ EN UN ERROR (lo de antes del error sí corrió y sigue en la sesión). Léelo, ' +
    'corrige el código y vuelve a llamar. No le enseñes el error al tesista si lo puedes ' +
    'arreglar tú.',
  tiempo:
    'SE CORTÓ POR TIEMPO: la orden pasó del límite. Nada de esta orden quedó en la sesión, ' +
    'que sigue como antes. Divide el trabajo en órdenes más cortas.',
  cortado:
    'SE CORTÓ ANTES DE TERMINAR, casi seguro por memoria. Nada de esta orden quedó en la ' +
    'sesión, que sigue como antes. Evita crear objetos enormes.',
};

function ultimos(textoLargo) {
  const t = String(textoLargo ?? '');
  return t.length > MAXIMO_ANALISIS ? t.slice(-MAXIMO_ANALISIS) : t;
}

/**
 * Guarda el guion y la consola en el análisis del proyecto.
 *
 * Es lo que antes hacía el botón «Enviar a mi conector»: desde aquí lo leen
 * `ver_analisis`, el aviso de `mi_proyecto` y el repaso de cifras. Devuelve
 * false si no se pudo, para decírselo a Claude en vez de callarlo.
 */
async function guardarEnElProyecto({ userId, productCode, guion, consola }) {
  try {
    await projectService.recibirAnalisis({
      userId,
      productCode,
      script: ultimos(guion),
      salida: ultimos(consola),
    });
    return true;
  } catch (error) {
    logger.error({ err: error, userId }, 'No se pudo guardar en el proyecto el análisis de R');
    return false;
  }
}

function avisoDeSubida({ userId, productCode }) {
  const { url, minutos } = enlaces.enlaceDeSubida({ userId, productCode });
  return (
    `TODAVÍA NO HAY DATOS. Dale al tesista este enlace para que suba su matriz, en Excel o ` +
    `CSV (caduca en ${minutos} minutos):${N}${url}${N}${N}` +
    'Dáselo tal cual y dile que vuelva aquí cuando lo haya subido. Entonces llama otra vez a ' +
    'trabajar_en_r sin código y verás sus columnas.'
  );
}

// ── La herramienta ──────────────────────────────────────────────────────────

/**
 * Lo que hace `trabajar_en_r`.
 *
 * Devuelve `{ contenido, bloqueo }`: el contenido va tal cual al cliente MCP, y
 * el bloqueo —si el filtro paró el código— es para que la herramienta lo anote
 * en el uso de la licencia.
 */
async function trabajar({ userId, productCode, codigo, reiniciar = false, descargar }) {
  const m = motorActual();
  if (!m || !(await m.listo())) return { contenido: texto(NO_DISPONIBLE) };

  const orden = typeof codigo === 'string' ? codigo.trim() : '';

  if (orden) {
    const bloqueo = filtro.revisar(orden);
    if (bloqueo) {
      logger.warn({ userId, regla: bloqueo.regla, fragmento: bloqueo.fragmento }, 'Código de R bloqueado');
      return {
        bloqueo,
        contenido: texto(
          `NO SE EJECUTÓ: el código ${bloqueo.motivo} («${bloqueo.fragmento}»), y eso no se ` +
            'permite aquí. Esta sesión de R solo trabaja con los datos del tesista, dentro de su ' +
            'carpeta y sin conexión. Si era parte del análisis, reescríbelo sin eso; si te lo ' +
            'pidió el tesista, explícale que no está disponible.',
        ),
      };
    }
  }

  const proyecto = await projectRepository.asegurar(userId, productCode);
  const sesion = proyecto.id;

  let hecho = null;
  try {
    if (reiniciar) hecho = await m.reiniciar(sesion);
    if (orden) hecho = await m.ejecutar(sesion, orden);
  } catch (error) {
    if (error instanceof MotorNoDisponible) {
      logger.error({ err: error, userId }, 'El motor de R no está disponible');
      return { contenido: texto(NO_DISPONIBLE) };
    }
    if (error instanceof MotorOcupado) {
      return {
        contenido: texto(
          'Ahora mismo hay varios análisis en marcha y no quedó sitio. No se ejecutó nada: ' +
            'vuelve a llamar con el mismo código en unos segundos.',
        ),
      };
    }
    throw error;
  }

  const partes = [];
  const imagenes = [];

  if (hecho) {
    const aviso = RESULTADOS[hecho.resultado];
    if (aviso) partes.push(aviso);
    if (reiniciar && !orden) partes.push('Sesión reiniciada: se borraron los objetos y se volvieron a leer los datos.');

    partes.push(`CONSOLA:${N}${recortarConsola(hecho.salida) || '(sin salida)'}`);

    const estado = describirEstado({ ...hecho.estado, archivos: hecho.archivos });
    if (estado) partes.push(estado);

    if (hecho.resultado === 'ok') {
      const lecturas = catalogo.comoSeLee(orden);
      if (lecturas.length > 0) {
        partes.push(
          `CÓMO SE LEE (explícaselo al tesista con sus palabras):${N}${lecturas.map((l) => `· ${l}`).join(N)}`,
        );
      }
    }

    for (const grafico of hecho.graficos) {
      imagenes.push({ type: 'image', data: grafico.bytes.toString('base64'), mimeType: 'image/png' });
    }
    if (hecho.totalGraficos > 0) {
      const nombres = hecho.graficos.map((g) => g.nombre).join(', ');
      partes.push(
        `GRÁFICOS: ${hecho.totalGraficos}, adjuntos como imagen` +
          (hecho.totalGraficos > hecho.graficos.length ? ` (solo los ${hecho.graficos.length} primeros)` : '') +
          `. Para que el tesista los baje, usa descargar con su nombre: ${nombres}.`,
      );
    }

    const guardado = await guardarEnElProyecto({
      userId,
      productCode,
      guion: hecho.guion,
      consola: hecho.consola,
    });
    partes.push(
      guardado
        ? 'Guardado en su análisis: "ver_analisis" ya lo lee. Las cifras que vayan al texto, ' +
            'guárdalas con "guardar_analisis" (resultados).'
        : 'OJO: esta vez NO se pudo guardar en su análisis. Lo ejecutado sigue en la sesión; ' +
            'vuelve a intentarlo más tarde.',
    );
  } else if (reiniciar) {
    partes.push('Sesión reiniciada. No había datos que volver a leer.');
  }

  const actual = await m.estado(sesion);

  if (!hecho) {
    const estado = describirEstado(actual);
    if (estado) partes.push(estado);
    else if (actual.hayDatos) partes.push('La sesión tiene datos pero todavía no se ha ejecutado nada.');
  }

  if (descargar) {
    const nombre = String(descargar).trim();
    const bytes = await m.leerArchivo(sesion, nombre);
    if (bytes) {
      const { url, minutos } = enlaces.enlaceDeDescarga({ userId, productCode, archivo: nombre });
      partes.push(
        `Enlace para bajar «${nombre}» (caduca en ${minutos} minutos):${N}${url}${N}` +
          'DÁSELO AL TESISTA TAL CUAL.',
      );
    } else {
      const hay = actual.archivos.map((a) => a.nombre);
      partes.push(
        `No hay ningún archivo «${nombre}» en la sesión.` +
          (hay.length > 0 ? ` Los que hay: ${hay.join(', ')}.` : ' Todavía no se ha creado ninguno.'),
      );
    }
  }

  if (!actual.hayDatos) partes.push(avisoDeSubida({ userId, productCode }));

  return {
    contenido: { content: [{ type: 'text', text: partes.join(`${N}${N}`) }, ...imagenes] },
  };
}

// ── La subida ───────────────────────────────────────────────────────────────

/**
 * El archivo que llega desde la página del enlace.
 *
 * Lanza `ArchivoNoValido` si no es una hoja de datos, y los errores del motor
 * tal cual: la ruta los traduce.
 */
async function subirDatos({ userId, productCode, bytes }) {
  const m = motorActual();
  if (!m || !(await m.listo())) throw new MotorNoDisponible('El motor de R está apagado o sin instalar.');

  const preparado = formato.preparar(bytes);
  const proyecto = await projectRepository.asegurar(userId, productCode);
  const hecho = await m.subirDatos(proyecto.id, preparado);

  await guardarEnElProyecto({ userId, productCode, guion: hecho.guion, consola: hecho.consola });

  const dim = dimensiones(hecho.estado.objetos);
  const leido = hecho.resultado === 'ok' && dim !== null;

  return {
    leido,
    filas: dim?.filas ?? null,
    columnas: hecho.estado.columnas.map((c) => c.nombre),
    aviso: preparado.aviso,
    // Si R no pudo leerlo, las últimas líneas de la consola dicen por qué.
    detalle: leido ? null : recortarConsola(hecho.salida).split('\n').slice(-6).join('\n'),
  };
}

// ── El informe en Word ──────────────────────────────────────────────────────

const NOMBRE_DEL_INFORME = 'informe-de-resultados.docx';

/**
 * El texto del informe sin lo que tiene forma de cifra y no es un resultado.
 *
 * Los números de apartado («4.1. Resultados descriptivos»), de tabla y de
 * figura, y la versión del programa («R 4.3.3») se leían como decimales y se
 * marcaban en TODOS los informes. Un aviso que salta siempre se deja de leer, y
 * entonces tampoco se lee el día que marca un p-valor inventado. Las cifras de
 * las tablas y de los párrafos se siguen comprobando todas.
 */
function textoParaCifras(texto) {
  return String(texto)
    .split('\n')
    .filter((linea) => !/^\s*#/.test(linea) && !/^\s*!\[/.test(linea))
    .join('\n')
    .replace(/\b\d+(?:\.\d+){2,}\b/g, '')
    .replace(/\b(?:tabla|figura|apartado|secci[oó]n|cap[ií]tulo|anexo)\s+\d+(?:\.\d+)*\.?/gi, '')
    .replace(/^\s*\d+(?:\.\d+)+\.?\s/gm, '');
}

/**
 * El Word del análisis, en la norma que elija el tesista.
 *
 * Claude manda el contenido; aquí se buscan las figuras en la sesión, se ponen
 * las citas en la norma, se arma el Word, se deja en la sesión y se da el
 * enlace. Y se mira que cada cifra del informe esté en la consola de R: un
 * informe de resultados con un número que no devolvió ninguna prueba es
 * exactamente lo que este producto existe para evitar.
 *
 * Devuelve el contenido MCP tal cual.
 */
async function informe({ userId, productCode, titulo, texto: contenido, norma }) {
  const m = motorActual();
  if (!m || !(await m.listo())) return texto(NO_DISPONIBLE);

  const cuerpo = String(contenido ?? '').trim();
  if (!cuerpo) return texto('No mandaste el texto del informe: va en informe.texto.');

  const proyecto = await projectRepository.asegurar(userId, productCode);
  const sesion = proyecto.id;

  // Las figuras, antes que nada: sin ellas no se arma un informe a medias.
  const figuras = new Map();
  const faltan = [];
  for (const archivo of informeWord.figurasDe(cuerpo)) {
    const bytes = await m.leerArchivo(sesion, archivo);
    if (bytes && informeWord.dimensionesPng(bytes)) figuras.set(archivo, bytes);
    else faltan.push(archivo);
  }
  if (faltan.length > 0) {
    const hay = (await m.estado(sesion)).archivos.map((a) => a.nombre).filter((n) => /\.png$/i.test(n));
    return texto(
      `NO SE ARMÓ EL INFORME: no están en la sesión estas figuras: ${faltan.join(', ')}. ` +
        (hay.length > 0 ? `Los PNG que hay: ${hay.join(', ')}. ` : 'No hay ningún PNG guardado. ') +
        'Guárdalas antes con png("figura1.png", width = 1600, height = 1100, res = 200); …; dev.off() ' +
        'y vuelve a mandar el informe con esos nombres.',
    );
  }

  // Las citas, en la norma pedida o la del proyecto, con el APA de respaldo.
  const claves = citas.clavesDe(cuerpo);
  const fuentes = claves.length > 0 ? await referenceService.porClaves(claves, userId) : [];
  const porClave = new Map(fuentes.map((f) => [f.ref, f]));
  const idNorma = norma || proyecto.estiloCitas;

  let resuelto;
  try {
    const r = csl.renderizar({
      norma: idNorma,
      idioma: proyecto.idiomaCitas,
      capitulos: [{ titulo: titulo || 'Informe', texto: cuerpo }],
      porClave,
    });
    resuelto = {
      texto: r.textos[0],
      citas: r.citas,
      referencias: r.bibliografia ?? [],
      perdidas: r.perdidas,
      norma: r.norma,
    };
  } catch (error) {
    logger.error({ err: error, userId, norma: idNorma }, 'Informe de R: la norma falló, sale en APA');
    const r = citas.resolver(cuerpo, porClave);
    resuelto = {
      texto: r.texto,
      citas: null,
      referencias: citas.bibliografiaConCursivas([...r.usadas.values()]),
      perdidas: r.perdidas,
      norma: normas.normaDe('apa'),
    };
  }

  const buffer = await informeWord.armar({
    titulo,
    tema: proyecto.tema,
    texto: resuelto.texto,
    citas: resuelto.citas,
    referencias: resuelto.referencias,
    figuras,
  });
  await m.guardarArchivo(sesion, NOMBRE_DEL_INFORME, buffer);

  const { url, minutos } = enlaces.enlaceDeDescarga({ userId, productCode, archivo: NOMBRE_DEL_INFORME });
  const referencias = Array.isArray(resuelto.referencias)
    ? resuelto.referencias.length
    : (resuelto.referencias?.entradas?.length ?? 0);

  const partes = [
    `Informe listo: ${informeWord.cuantasTablas(cuerpo)} tablas, ${figuras.size} figuras y ` +
      `${referencias} referencias, con las citas en ${resuelto.norma.nombre}.`,
    `Enlace para bajarlo (caduca en ${minutos} minutos):${N}${url}${N}DÁSELO AL TESISTA TAL CUAL.`,
  ];

  if (resuelto.perdidas.length > 0) {
    partes.push(
      `OJO: ${resuelto.perdidas.length} citas no corresponden a ninguna de sus fuentes ` +
        `(${resuelto.perdidas.join(', ')}) y salen marcadas en el Word. Corrígelas y vuelve a armarlo.`,
    );
  }

  const sinRespaldo = cifras.sinRespaldo(textoParaCifras(cuerpo), [await m.consola(sesion)]);
  if (sinRespaldo.length > 0) {
    partes.push(
      `REVISA ESTAS CIFRAS: no aparecen en la consola de esta sesión, así que no salieron de R:${N}` +
        sinRespaldo
          .slice(0, 12)
          .map((c) => `· ${c.bruto} — «${c.contexto}»`)
          .join(N) +
        (sinRespaldo.length > 12 ? `${N}· … y ${sinRespaldo.length - 12} más` : '') +
        `${N}Si son un redondeo o un cálculo a mano, díselo al tesista; si no, corrígelas y vuelve a armar el informe.`,
    );
  }

  partes.push(
    'Si además quiere que forme parte de su tesis, guárdalo con "guardar_capitulo" en el capítulo ' +
      'de resultados (las figuras no van en el Word de la tesis: se pegan a mano).',
  );

  return texto(partes.join(`${N}${N}`));
}

/** Un archivo de la sesión, para la ruta de descarga. */
async function leerArchivo({ userId, productCode, archivo }) {
  const m = motorActual();
  if (!m) return null;
  const proyecto = await projectRepository.buscar(userId, productCode);
  if (!proyecto) return null;
  return m.leerArchivo(proyecto.id, archivo);
}

module.exports = {
  trabajar,
  informe,
  subirDatos,
  leerArchivo,
  disponible,
  usarMotor,
  describirEstado,
  recortarConsola,
};

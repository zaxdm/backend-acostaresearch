'use strict';

/**
 * Consejos de la plataforma, por el conector.
 *
 * POR QUÉ EXISTE
 * --------------
 * Lo que la web ofrece —conectar Zotero, subir su propio documento para que
 * Claude lo cite— solo lo usa quien lo descubre, y el tesista pasa el tiempo
 * en Claude, no en su perfil. Así que el conector se lo
 * dice, en el momento en que le sirve: conectar Zotero al empezar el marco
 * teórico, la página de R al llegar a resultados.
 *
 * LA SKILL VA PRIMERO
 * -------------------
 * El producto es el método; esto es la ayuda. Por eso:
 *   - un solo consejo cada vez, el que más importa ahora;
 *   - va DEBAJO del método o del panorama, nunca delante;
 *   - se le pide a Claude que lo diga en una frase al terminar el paso, no que
 *     interrumpa;
 *   - el mismo consejo no vuelve hasta pasados `DIAS_SIN_REPETIR`, y deja de
 *     salir en cuanto el tesista lo hace, porque la situación ya no se da.
 *
 * Solo sale en dos sitios: al pedir el panorama («mi_proyecto») y en el primer
 * tramo de un capítulo. Los demás tramos van limpios.
 */

const logger = require('../../config/logger');
const projectRepository = require('./project.repository');
const almacen = require('./project.storage');
const skillService = require('../skills/skill.service');
const propiasRepository = require('../references/propias.repository');
const bibliotecaRepository = require('../zotero/biblioteca.repository');
const { esApoyo, CAPITULOS_DE_RESULTADOS } = require('./project.service');

const DIAS_SIN_REPETIR = 7;
const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Los capítulos que se escriben con fuentes, por su nombre.
 *
 * Por el nombre y no por la clave, como `esApoyo`: así vale para la tesis
 * («Capítulo II · Marco teórico») y para el artículo («Fase 2 — Introducción»,
 * «Revisión de la literatura», «Mapeo bibliométrico») sin mantener dos listas.
 */
const CON_FUENTES =
  /problema|marco te[oó]rico|antecedentes|introducci[oó]n|revisi[oó]n de (la )?literatura|mapeo|discusi[oó]n/i;

/**
 * Qué consejo toca, o null.
 *
 * Pura a propósito: aquí se decide y se prueba; `consejoPara` solo reúne los
 * datos. El orden es la prioridad: primero lo que frena el paso de AHORA
 * (sin fuentes no hay marco teórico, sin análisis no hay resultados), después
 * lo que mejora la entrega.
 */
function elegir(estado) {
  const {
    actual = null,
    apoyos = [],
    fuentes = 0,
    zotero = null,
    analisisPendiente = false,
    todasListas = false,
    palabras = 0,
    estiloCitas = null,
    plantillaAt = null,
    mostrados = {},
    ahora = new Date(),
  } = estado;

  const abriendoApoyo = Boolean(actual && esApoyo(actual.displayName));

  const candidatos = [
    // Conectado pero sin elegir colección: no se importa nada, en ninguna fase.
    zotero && !zotero.collectionName ? 'zotero-coleccion' : null,
    fuentes === 0 && !zotero && actual && CON_FUENTES.test(actual.displayName) ? 'fuentes' : null,
    analisisPendiente ? 'analisis' : null,
    todasListas && apoyos.length > 0 && !abriendoApoyo ? 'terminada' : null,
    palabras > 0 && !estiloCitas ? 'norma' : null,
    // Ya no hay recuadro en el perfil: si Claude no lo pregunta, nadie lo sube.
    palabras > 0 && !plantillaAt ? 'formato' : null,
  ].filter(Boolean);

  return (
    candidatos.find((clave) => {
      const cuando = mostrados?.[clave] ? new Date(mostrados[clave]).getTime() : NaN;
      return Number.isNaN(cuando) || ahora.getTime() - cuando >= DIAS_SIN_REPETIR * DIA_MS;
    }) ?? null
  );
}

/** Lo que tiene que decirle Claude, según el consejo. */
function redactar(clave, { esArticulo = false, apoyos = [] } = {}) {
  const obra = esArticulo ? 'su artículo' : 'su tesis';

  switch (clave) {
    case 'zotero-coleccion':
      return (
        'Tiene su Zotero conectado pero no eligió qué traer, así que no se ha importado nada. ' +
        'En su perfil de acostaresearch.com, en «Tu Zotero», que elija una colección o toda la ' +
        'biblioteca; se actualiza sola cada noche.'
      );
    case 'fuentes':
      return (
        'Todavía no tiene fuentes propias. Si conecta su Zotero («Tu Zotero», en su perfil de ' +
        'acostaresearch.com) o sube su export de Scopus, Web of Science o SciELO («Mis ' +
        'fuentes»), las citas saldrán de SUS fuentes. Mientras tanto, sigues pudiendo buscar en ' +
        'la literatura publicada.'
      );
    case 'analisis':
      return (
        'Para los resultados puedes correr TÚ su análisis en R, aquí mismo, con "trabajar_en_r": ' +
        'él no tiene que instalar nada ni escribir código, solo subir su matriz desde el enlace ' +
        'que te da la herramienta. Si prefiere su RStudio, que te pegue el script y la salida.'
      );
    case 'terminada':
      return (
        `Tiene todas las fases terminadas. Antes de entregar ${obra}, puede pasar el texto por ` +
        `${apoyos.join(' y ')}, y descargar el Word completo desde su perfil de ` +
        'acostaresearch.com.'
      );
    case 'norma':
      return (
        'Ya tiene texto escrito y no ha elegido norma de citas, así que el Word sale en APA 7. ' +
        // Ya no hay selector en el panel: la norma se pregunta en la conversación.
        'PREGÚNTALE qué norma le piden su universidad o su asesor y guárdala con "guardar_avance" ' +
        '(estiloCitas): no hay que reescribir nada.'
      );
    case 'formato':
      return (
        `Ya tiene texto escrito y no ha subido el formato de su universidad, así que ${obra} sale ` +
        'con el formato por defecto. PREGÚNTALE si su facultad le dio un formato o plantilla y, si ' +
        'lo tiene, dale el enlace para subirlo con "formato_de_la_universidad".'
      );
    default:
      return null;
  }
}

/** El consejo, con las instrucciones de cuándo decirlo. */
function envolver(texto) {
  return [
    'CONSEJO DE LA PLATAFORMA — para DESPUÉS, no lo antepongas al trabajo',
    texto,
    'Cuándo decírselo: en UNA frase, al terminar este paso o en una pausa natural. No ' +
      'interrumpas el capítulo por esto ni lo repitas en esta conversación. Si te dice que ' +
      'ya lo hizo, olvídalo.',
  ].join('\n');
}

/**
 * El consejo para este momento, ya envuelto, o null.
 *
 * `capitulo` es la clave del capítulo que se está abriendo; sin ella —desde
 * «mi_proyecto»— se toma la fase en curso o la primera sin terminar, igual que
 * el panel.
 *
 * Las consultas van una detrás de otra: la base admite cinco conexiones y esto
 * se suma a lo que ya hace cada llamada. Quien llama tiene que envolverlo en un
 * catch: un consejo que falla no puede dejar a nadie sin su capítulo.
 */
async function consejoPara({ userId, productCode, capitulo = null, ahora = new Date() }) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  // Sin proyecto no hay dónde anotar qué se dijo, y se repetiría en cada
  // conversación. Además, quien no ha empezado necesita el método, no consejos.
  if (!proyecto) return null;

  const catalogo = await skillService.listCatalog(productCode);
  const fases = catalogo.filter((s) => !esApoyo(s.displayName));
  const apoyos = catalogo.filter((s) => esApoyo(s.displayName)).map((s) => s.displayName);
  const porCapitulo = new Map((proyecto.stages ?? []).map((e) => [e.skillCode, e]));
  const estadoDe = (code) => porCapitulo.get(code)?.estado ?? 'PENDIENTE';

  const todasListas = fases.length > 0 && fases.every((f) => estadoDe(f.code) === 'LISTO');
  const actual = capitulo
    ? (catalogo.find((s) => s.code === capitulo) ?? null)
    : (fases.find((f) => estadoDe(f.code) === 'EN_CURSO') ??
      fases.find((f) => estadoDe(f.code) !== 'LISTO') ??
      null);

  const fuentes = await propiasRepository.contar(userId);
  const zotero = await bibliotecaRepository.deUsuario(userId);

  // Solo en el capítulo de resultados, y solo si no hay análisis ni cifras. Si
  // no se puede comprobar el disco, se calla: mejor sin consejo que uno falso.
  let analisisPendiente = false;
  if (actual && CAPITULOS_DE_RESULTADOS.includes(actual.code)) {
    const cifras = porCapitulo.get(actual.code)?.datos?.resultados ?? [];
    if (cifras.length === 0) {
      const fecha = await almacen.fechaDeAnalisis(proyecto.id, actual.code).catch(() => 'no-se-sabe');
      analisisPendiente = !fecha;
    }
  }

  const mostrados =
    proyecto.consejos && typeof proyecto.consejos === 'object' ? proyecto.consejos : {};

  const clave = elegir({
    actual,
    fases,
    apoyos,
    fuentes,
    zotero,
    analisisPendiente,
    todasListas,
    palabras: (proyecto.stages ?? []).reduce((suma, e) => suma + (e.palabras ?? 0), 0),
    estiloCitas: proyecto.estiloCitas,
    plantillaAt: proyecto.plantillaAt,
    mostrados,
    ahora,
  });
  if (!clave) return null;

  const texto = redactar(clave, { esArticulo: productCode.startsWith('ARTICULO'), apoyos });
  if (!texto) return null;

  // Si no se puede anotar, se da igual: repetirlo la próxima vez es menos malo
  // que no darlo.
  await projectRepository
    .anotarConsejos(proyecto.id, { ...mostrados, [clave]: ahora.toISOString() }, proyecto.updatedAt)
    .catch((error) => logger.error({ err: error, projectId: proyecto.id }, 'No se pudo anotar el consejo'));

  return envolver(texto);
}

module.exports = { consejoPara, elegir, redactar, DIAS_SIN_REPETIR };

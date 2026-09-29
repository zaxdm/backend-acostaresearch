'use strict';

/**
 * El avance de su tesis, su artículo o su informe, subido desde el panel.
 *
 * No es el documento que Claude cita o humaniza (`documento.service`): ese se
 * sube por el enlace que da Claude en la conversación y se devuelve tal cual,
 * con su formato. Este se reparte entre las fases (`project.avance`) y cada
 * capítulo reconocido se guarda como el texto de su fase, que pasa a «En curso».
 * Así el panel dice por dónde va de verdad y Claude sigue desde lo escrito.
 *
 * NO PISA LO QUE ESCRIBIÓ CLAUDE
 * ------------------------------
 * Si una fase ya tiene guardado un texto más largo que el del Word, se deja: lo
 * más probable es que sea el capítulo trabajado con Claude y el Word una versión
 * anterior. Se le dice cuál se conservó, para que no crea que se perdió.
 *
 * Tampoco cierra fases. «Terminada» la sigue dando Claude cuando el tesista
 * aprueba el capítulo; un capítulo escrito no es un capítulo revisado.
 */

const projectRepository = require('./project.repository');
const almacen = require('./project.storage');
const documento = require('./project.documento');
const { repartir } = require('./project.avance');
const skillService = require('../skills/skill.service');
const { perfilDe } = require('../productos/producto.perfil');
const { enSerie } = require('../../shared/utils/enSerie');
const redaccion = require('./redaccion.service');

/** El mismo turno que `guardar_capitulo`: los dos escriben el texto de las fases. */
const claveDeProyecto = (userId, productCode) => `proyecto:${userId}:${productCode}`;

/** Ningún capítulo reconocido: se explica cómo titularlos en vez de guardar nada. */
class AvanceSinCapitulos extends Error {}

async function proyectoConLicencia(userId, productCode) {
  const conLicencia = await projectRepository.productosConLicencia(userId);
  if (!conLicencia.includes(productCode)) return null;
  const actual = await projectRepository.buscar(userId, productCode);
  return actual ?? projectRepository.asegurar(userId, productCode);
}

/**
 * Lee el Word, reparte sus capítulos y los guarda en sus fases.
 *
 * Devuelve null sin licencia vigente del método. Lanza `DocumentoNoValido` si
 * el archivo no es un Word con texto y `AvanceSinCapitulos` si no se reconoce
 * ningún capítulo.
 */
function subir(argumentos) {
  return enSerie(claveDeProyecto(argumentos.userId, argumentos.productCode), () => subirEnSuTurno(argumentos));
}

async function subirEnSuTurno({ userId, productCode, buffer, nombre }) {
  const parrafos = documento.leer(buffer);
  if (parrafos.length === 0) {
    throw new documento.DocumentoNoValido('Ese documento no tiene texto.');
  }

  const proyecto = await proyectoConLicencia(userId, productCode);
  if (!proyecto) return null;

  const catalogo = await skillService.listCatalog(productCode);
  const { porFase, sinUbicar } = repartir(parrafos, {
    catalogo,
    esquema: proyecto.esquema?.capitulos ?? null,
    tipo: perfilDe(productCode).tipo,
  });

  if (porFase.size === 0) {
    throw new AvanceSinCapitulos(
      'No reconocimos ningún capítulo en tu documento. Ponle a cada uno su título en una línea ' +
        'aparte —«Capítulo II: Marco teórico», «Metodología», «Resultados»—, mejor con el estilo ' +
        '«Título 1» de Word, y vuelve a subirlo.',
    );
  }

  const nombres = new Map(catalogo.map((s) => [s.code, s.displayName]));
  const previas = new Map((proyecto.stages ?? []).map((e) => [e.skillCode, e]));
  const fases = [];

  // En el orden del método, no en el del Word: así se leen en el panel.
  for (const skill of catalogo) {
    const texto = porFase.get(skill.code);
    if (!texto) continue;

    const palabras = almacen.palabrasDe(texto);
    const previa = previas.get(skill.code);
    const fase = { code: skill.code, displayName: nombres.get(skill.code), palabras };

    if ((previa?.palabras ?? 0) > palabras) {
      fases.push({ ...fase, conservada: true, palabrasGuardadas: previa.palabras });
      continue;
    }

    const guardado = await almacen.guardar(proyecto.id, skill.code, texto);
    await projectRepository.guardarEtapa(proyecto.id, skill.code, {
      estado: previa?.estado === 'LISTO' ? undefined : 'EN_CURSO',
      palabras: guardado.palabras,
      textoAt: new Date(),
    });
    fases.push({ ...fase, conservada: false });
  }

  const ficha = {
    nombre: nombre || 'avance.docx',
    subidoAt: new Date().toISOString(),
    palabras: parrafos.reduce((suma, p) => suma + p.texto.trim().split(/\s+/).length, 0),
    sinUbicar,
    fases,
  };
  await almacen.guardarFichaDeAvance(proyecto.id, ficha);
  // Lo que escribió por su cuenta es la mejor muestra de su voz mientras no
  // haya un reporte de IA que diga qué párrafos son suyos de verdad.
  await redaccion.recordarVozDelAvance(proyecto.id, [...porFase.values()]);
  return ficha;
}

/** Lo que dice el panel al terminar de subirlo. */
function mensajeDeSubida(ficha) {
  const guardadas = ficha.fases.filter((f) => !f.conservada);
  const conservadas = ficha.fases.filter((f) => f.conservada);
  const lista = (fases) => fases.map((f) => `«${f.displayName}»`).join(', ');

  return [
    guardadas.length > 0
      ? `Listo: ${guardadas.length === 1 ? 'pasó a su fase' : 'pasaron a sus fases'} ${lista(guardadas)}.`
      : 'Listo.',
    conservadas.length > 0
      ? `Se conservó lo que ya tenías con Claude en ${lista(conservadas)}, que era más largo que tu Word.`
      : '',
    'Abre Claude y dile «sigamos»: seguirá desde lo que ya escribiste.',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * La ficha para el panel, o null si no subió ningún avance. Un fallo al leerla
 * tampoco es motivo para que el panel entero no cargue: se queda sin el aviso.
 */
async function fichaDelPanel(proyecto) {
  if (!proyecto?.id) return null;
  try {
    return await almacen.leerFichaDeAvance(proyecto.id);
  } catch {
    return null;
  }
}

/** Quita la ficha. Lo que ya pasó a las fases se queda: es su texto, y se sigue trabajando ahí. */
async function quitar(userId, productCode) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  return proyecto ? almacen.borrarFichaDeAvance(proyecto.id) : false;
}

module.exports = { subir, quitar, fichaDelPanel, mensajeDeSubida, AvanceSinCapitulos };

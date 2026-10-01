'use strict';

/**
 * Lo que el servidor hace por la redacción para que el Claude del tesista no
 * gaste la sesión en ello.
 *
 * QUÉ HAY AQUÍ
 * ------------
 * - Los capítulos guardados, por párrafos numerados (`capituloNumerado`), y el
 *   cambio de párrafos sueltos (`reescribirParrafos`). Antes, humanizar o bajar
 *   la similitud de tres párrafos obligaba a reenviar el capítulo entero con
 *   `guardar_capitulo`.
 * - Lo que marcó Turnitin (`loMarcado`), con el reporte de IA o el de similitud,
 *   cruzado con el Word subido o con los capítulos guardados; o, sin reporte,
 *   toda la prosa de los capítulos (`tipo: 'todo'`) que aún no se humanizó.
 * - La voz del tesista (`voz`): párrafos que escribió él, sacados del reporte de
 *   IA (los que dio limpios) o de su avance. La reciben las skills que redactan.
 * - Los avisos de redacción de un capítulo recién guardado (`avisosDeRedaccion`),
 *   que sustituyen a la auditoría que las skills imprimían en el chat.
 *
 * El reporte se sube por el enlace de `subir_mi_documento` (ver
 * `documento.service.subirReporte`); cómo se lee el PDF está en
 * `project.reporte-ia`.
 */

const crypto = require('node:crypto');
const projectRepository = require('./project.repository');
const almacen = require('./project.storage');
const documento = require('./project.documento');
const reescritura = require('./project.reescritura');
const citas = require('./project.citas');
const reporteTurnitin = require('./project.reporte-ia');
const controles = require('./project.humanizado-controles');
const { enSerie } = require('../../shared/utils/enSerie');

/** Caracteres por tanda de lo marcado: se lee y se reescribe en la misma vuelta. */
const POR_TANDA = 12000;

/** Párrafos de menos palabras no se humanizan en «todo»: rótulos, ítems de lista. */
const MINIMO_PARA_HUMANIZAR = 12;

/** Cuántas huellas de párrafos humanizados se guardan como mucho. */
const TOPE_DE_HUELLAS = 5000;

/** Huella de un párrafo sin sus marcas de cita ni sus espacios: su identidad. */
const huella = (texto) =>
  crypto
    .createHash('sha1')
    .update(quitarMarcas(texto).replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 16);

/** Caracteres por tanda del capítulo numerado, como `ver_capitulo`. */
const POR_TANDA_CAPITULO = 24000;

/** El orden del método, para recorrer los capítulos como están en la tesis. */
const ORDEN = [
  'tema-y-delimitacion',
  'problema-y-objetivos',
  'marco-teorico',
  'metodologia',
  'aspectos-administrativos',
  'instrumento-investigacion',
  'recoleccion-datos',
  'analisis-datos-rstudio',
  'analisis-cualitativo',
  'discusion',
  'conclusiones-abstract',
];

const posicion = (code) => {
  const i = ORDEN.indexOf(code);
  return i < 0 ? ORDEN.length : i;
};

// ── Los párrafos de un capítulo ─────────────────────────────────────────────

/**
 * Un capítulo guardado, partido en bloques por líneas en blanco, con qué es cada
 * uno. Solo la prosa se reescribe: títulos, tablas, figuras y listas no.
 *
 * Se devuelven también los separadores, para volver a juntarlo tal cual.
 */
function bloques(texto) {
  const trozos = String(texto).split(/(\n[ \t]*\n+)/);
  const salida = [];
  let n = 0;
  for (let i = 0; i < trozos.length; i += 2) {
    const contenido = trozos[i];
    const separador = trozos[i + 1] ?? '';
    const limpio = contenido.trim();
    let tipo = 'texto';
    if (limpio === '') tipo = 'vacio';
    else if (/^#{1,6}\s/.test(limpio)) tipo = 'titulo';
    else if (/^\|/.test(limpio)) tipo = 'tabla';
    else if (/^(!\[|\[figura|\[insertar aqu[ií])/i.test(limpio)) tipo = 'figura';
    else if (/^([-*•]|\d+[.)])\s/.test(limpio)) tipo = 'lista';
    else if (/^((tabla|figura)\s+\d+|nota\.\s)/i.test(limpio)) tipo = 'rotulo';
    else if (!/[.:;?!)»"]$/.test(limpio) && limpio.length < 140 && !limpio.includes('\n')) tipo = 'titulo';
    if (tipo !== 'vacio') n += 1;
    salida.push({ n: tipo === 'vacio' ? null : n, tipo, texto: contenido, separador });
  }
  return salida;
}

/** Solo los párrafos de prosa, con su número. */
const prosa = (texto) => bloques(texto).filter((b) => b.tipo === 'texto');

/** Los capítulos con texto de este proyecto, en el orden del método. */
async function capitulosConTexto(proyecto) {
  const codigos = (proyecto?.stages ?? [])
    .filter((e) => (e.palabras ?? 0) > 0)
    .map((e) => e.skillCode)
    .sort((a, b) => posicion(a) - posicion(b));
  const salida = [];
  for (const code of codigos) {
    const texto = await almacen.leer(proyecto.id, code);
    if (texto && texto.trim()) salida.push({ code, texto });
  }
  return salida;
}

/**
 * El capítulo con cada bloque numerado («¶7 …»), por tandas, para poder
 * cambiar párrafos sueltos con `reescribirParrafos`. Null si no tiene texto.
 */
async function capituloNumerado(userId, productCode, capitulo, { desde = 1 } = {}) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  const texto = proyecto ? await almacen.leer(proyecto.id, capitulo) : null;
  if (!texto || !texto.trim()) return null;

  const lineas = [];
  let largo = 0;
  let siguiente = null;
  const todos = bloques(texto).filter((b) => b.tipo !== 'vacio');
  for (const b of todos) {
    if (b.n < desde) continue;
    if (largo >= POR_TANDA_CAPITULO) {
      siguiente = b.n;
      break;
    }
    const marca = b.tipo === 'texto' ? '' : ` [${b.tipo}]`;
    const linea = `¶${b.n}${marca} ${b.texto.trim()}`;
    lineas.push(linea);
    largo += linea.length;
  }
  return { lineas, siguiente, total: todos.length, palabras: almacen.palabrasDe(texto) };
}

// ── Cambiar párrafos sueltos de un capítulo ─────────────────────────────────

const quitarMarcas = (texto) =>
  String(texto)
    .replace(/[ \t]*\[AR[0-9A-F]{8}(?::[^\]\n]{1,40})?\]/gi, '')
    .replace(/[ \t]*\[FALTA FUENTE\]/gi, '');

const marcasDe = (texto) =>
  [
    ...[...String(texto ?? '').matchAll(citas.MARCA)].map((m) => m[0]),
    ...Array.from({ length: String(texto ?? '').match(documento.FALTA)?.length ?? 0 }, () => '[FALTA FUENTE]'),
  ].sort();

/**
 * Reemplaza párrafos de prosa de un capítulo guardado y lo vuelve a guardar.
 *
 * Cada párrafo se acepta o se rechaza por separado, con las mismas reglas que
 * el Word subido: las cifras, lo que va entre comillas y los apellidos citados
 * no cambian, y las claves [AR…] y [FALTA FUENTE] salen las mismas. Devuelve
 * null si el capítulo no tiene texto.
 */
function reescribirParrafos({ userId, productCode, capitulo, parrafos }) {
  return enSerie(`redaccion:${userId}:${productCode}:${capitulo}`, () =>
    reescribirEnSuTurno({ userId, productCode, capitulo, parrafos }),
  );
}

async function reescribirEnSuTurno({ userId, productCode, capitulo, parrafos }) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  const texto = proyecto ? await almacen.leer(proyecto.id, capitulo) : null;
  if (!texto || !texto.trim()) return null;

  const todos = bloques(texto);
  const porNumero = new Map(todos.filter((b) => b.n !== null).map((b) => [b.n, b]));
  const rechazados = [];
  const avisos = [];
  let guardados = 0;

  for (const { p, texto: nuevo } of parrafos) {
    const bloque = porNumero.get(Number(p));
    const rechazar = (motivo) => rechazados.push({ p, motivo });
    if (!bloque) {
      rechazar('no hay ningún párrafo con ese número en el capítulo');
      continue;
    }
    if (bloque.tipo !== 'texto') {
      rechazar(`es un ${bloque.tipo}: solo se reescriben párrafos de prosa`);
      continue;
    }
    const limpio = String(nuevo).trim();
    if (/\n\s*\n/.test(limpio)) {
      rechazar('trae una línea en blanco: un párrafo sale como un párrafo');
      continue;
    }
    const antes = marcasDe(bloque.texto);
    const despues = marcasDe(limpio);
    if (antes.join(' ') !== despues.join(' ')) {
      rechazar(
        `el párrafo lleva ${antes.join(' ') || 'ninguna marca'} y el nuevo trae ${despues.join(' ') || 'ninguna'}: ` +
          'cada clave viaja con su afirmación, sin borrarla ni añadir otra',
      );
      continue;
    }
    const motivo = reescritura.comprobarReescritura(quitarMarcas(bloque.texto), quitarMarcas(limpio));
    if (motivo) {
      rechazar(motivo);
      continue;
    }
    avisos.push(...controles.avisosDelParrafo(p, quitarMarcas(bloque.texto), quitarMarcas(limpio)));
    // La sangría o los espacios de delante se quedan como estaban.
    const sangria = bloque.texto.match(/^\s*/)[0];
    bloque.texto = `${sangria}${limpio}`;
    guardados += 1;
  }

  let palabras = almacen.palabrasDe(texto);
  if (guardados > 0) {
    // Lo guardado no vuelve a salir en «humanizar todo».
    const nuevas = parrafos
      .filter(({ p }) => !rechazados.some((r) => r.p === p))
      .map(({ texto: t }) => huella(t));
    const previas = await almacen.leerHumanizadosDeCapitulos(proyecto.id);
    await almacen.guardarHumanizadosDeCapitulos(
      proyecto.id,
      [...new Set([...previas, ...nuevas])].slice(-TOPE_DE_HUELLAS),
    );
    const junto = todos.map((b) => `${b.texto}${b.separador}`).join('');
    ({ palabras } = await almacen.guardar(proyecto.id, capitulo, junto));
    const previa = (proyecto.stages ?? []).find((e) => e.skillCode === capitulo);
    await projectRepository.guardarEtapa(proyecto.id, capitulo, {
      estado: previa?.estado === 'LISTO' ? undefined : 'EN_CURSO',
      palabras,
      textoAt: new Date(),
    });
  }
  return { guardados, rechazados, avisos, palabras };
}

// ── Lo que marcó Turnitin en los capítulos guardados ────────────────────────

const leerReporte = (proyecto, tipo) =>
  tipo === 'similitud' ? almacen.leerReporteSimilitud(proyecto.id) : almacen.leerReporteIaDeDocumento(proyecto.id);

/**
 * Los párrafos de los capítulos guardados que el reporte marcó, por tandas.
 *
 * Lo ya reescrito deja de coincidir con el reporte y no vuelve a salir: la
 * tanda siguiente se pide volviendo a llamar. Lo que se decidió no tocar (un
 * objetivo, una definición normada) se pasa en `saltar` para que no vuelva.
 *
 * `{ sinReporte }` si no hay reporte de ese tipo; `{ sinTexto }` si no hay
 * capítulos guardados.
 */
async function loMarcadoEnCapitulos(userId, productCode, { tipo = 'ia', saltar = [], capitulo = null } = {}) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  if (!proyecto) return { sinTexto: true };
  if (tipo === 'todo') return todoEnCapitulos(proyecto, { saltar, capitulo });
  const reporte = await leerReporte(proyecto, tipo);
  if (!reporte) return { sinReporte: true };

  const capitulos = await capitulosConTexto(proyecto);
  if (capitulos.length === 0) return { sinTexto: true, reporte: fichaDe(reporte, tipo) };

  const parrafos = capitulos.flatMap(({ code, texto }) =>
    prosa(texto).map((b) => ({ id: `${code}#${b.n}`, code, n: b.n, texto: b.texto.trim() })),
  );
  const cruce = reporteTurnitin.cruzar(reporte, parrafos);
  const fuera = new Set(saltar.map(String));
  const marcados = parrafos.filter((p) => cruce.get(p.id)?.marcado);
  const pendientes = marcados.filter((p) => !fuera.has(p.id));

  const lineas = [];
  let largo = 0;
  for (const p of pendientes) {
    if (largo >= POR_TANDA) break;
    const linea = `[${p.code} ¶${p.n}] (${cruce.get(p.id).porcentaje} %) ${p.texto}`;
    lineas.push(linea);
    largo += linea.length;
  }

  const porCapitulo = {};
  for (const p of marcados) porCapitulo[p.code] = (porCapitulo[p.code] ?? 0) + 1;

  if (tipo === 'ia') await recordarVozDelReporte(proyecto, parrafos, cruce);

  return {
    reporte: fichaDe(reporte, tipo),
    lineas,
    marcados: marcados.length,
    pendientes: pendientes.length,
    porCapitulo,
  };
}

/**
 * Sin reporte: toda la prosa de los capítulos guardados (o de uno) que todavía
 * no se humanizó, por tandas, igual que lo marcado. Es el camino rápido cuando
 * el tesista pide «humaniza mi capítulo» y no tiene reporte de Turnitin.
 */
async function todoEnCapitulos(proyecto, { saltar, capitulo }) {
  const capitulos = (await capitulosConTexto(proyecto)).filter((c) => !capitulo || c.code === capitulo);
  if (capitulos.length === 0) return { sinTexto: true };

  const hechos = new Set(await almacen.leerHumanizadosDeCapitulos(proyecto.id));
  const fuera = new Set(saltar.map(String));
  const parrafos = capitulos.flatMap(({ code, texto }) =>
    prosa(texto)
      .map((b) => ({ id: `${code}#${b.n}`, code, n: b.n, texto: b.texto.trim() }))
      .filter((p) => p.texto.split(/\s+/).length >= MINIMO_PARA_HUMANIZAR),
  );
  const pendientes = parrafos.filter((p) => !fuera.has(p.id) && !hechos.has(huella(p.texto)));

  const lineas = [];
  let largo = 0;
  for (const p of pendientes) {
    if (largo >= POR_TANDA) break;
    const linea = `[${p.code} ¶${p.n}] ${p.texto}`;
    lineas.push(linea);
    largo += linea.length;
  }

  const porCapitulo = {};
  for (const p of pendientes) porCapitulo[p.code] = (porCapitulo[p.code] ?? 0) + 1;

  return { lineas, marcados: parrafos.length, pendientes: pendientes.length, porCapitulo };
}

function fichaDe(reporte, tipo) {
  return {
    tipo,
    nombre: reporte.nombre,
    subidoAt: reporte.subidoAt,
    porcentaje: reporte.porcentaje ?? null,
    desglose: reporte.desglose ?? null,
    fuentes: reporte.fuentes ?? [],
  };
}

// ── La voz del tesista ──────────────────────────────────────────────────────

const PARRAFOS_DE_VOZ = 3;
const MINIMO_PARA_VOZ = 50;

/**
 * Guarda como voz los párrafos que Turnitin dio limpios. Manda sobre la del
 * avance: lo que el reporte da en 0 % es lo más seguro que escribió él.
 */
async function recordarVozDelReporte(proyecto, parrafos, cruce) {
  const limpios = parrafos
    .filter((p) => cruce.get(p.id)?.porcentaje === 0 && p.texto.split(/\s+/).length >= MINIMO_PARA_VOZ)
    .slice(0, PARRAFOS_DE_VOZ)
    .map((p) => quitarMarcas(p.texto).slice(0, 1200));
  if (limpios.length === 0) return;
  await almacen.guardarVoz(proyecto.id, { origen: 'reporte-ia', parrafos: limpios, at: new Date().toISOString() });
}

/**
 * La voz a partir del avance que subió desde el panel, si no hay otra mejor.
 * Se toman párrafos largos de prosa repartidos por el avance, no los tres
 * primeros, que suelen ser del planteamiento y se parecen entre sí.
 */
async function recordarVozDelAvance(proyectoId, textos) {
  const actual = await almacen.leerVoz(proyectoId);
  if (actual?.origen === 'reporte-ia') return;
  const candidatos = textos
    .flatMap((t) => prosa(t).map((b) => quitarMarcas(b.texto).trim()))
    .filter((t) => t.split(/\s+/).length >= MINIMO_PARA_VOZ + 10);
  if (candidatos.length === 0) return;
  const paso = Math.max(1, Math.floor(candidatos.length / PARRAFOS_DE_VOZ));
  const elegidos = candidatos.filter((_, i) => i % paso === 0).slice(0, PARRAFOS_DE_VOZ);
  await almacen.guardarVoz(proyectoId, {
    origen: 'avance',
    parrafos: elegidos.map((t) => t.slice(0, 1200)),
    at: new Date().toISOString(),
  });
}

/** `{ origen, parrafos }` o null. */
async function voz(userId, productCode) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  return proyecto ? almacen.leerVoz(proyecto.id) : null;
}

/**
 * Lo que `redactar` le cuenta a Claude antes de la skill: si esta fase ya tiene
 * texto que vino del avance que subió el tesista, y su voz.
 *
 * Sin lo primero, la skill empezaba de cero y le proponía redactar un capítulo
 * que ya tenía medio escrito.
 */
async function contextoDeRedaccion(userId, productCode, capitulo) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  if (!proyecto) return { avance: null, voz: null };
  const [ficha, vozGuardada] = await Promise.all([
    almacen.leerFichaDeAvance(proyecto.id).catch(() => null),
    almacen.leerVoz(proyecto.id).catch(() => null),
  ]);
  const fase = ficha?.fases?.find((f) => f.code === capitulo && !f.conservada);
  const etapa = (proyecto.stages ?? []).find((e) => e.skillCode === capitulo);
  return {
    avance: fase ? { nombre: ficha.nombre, palabras: etapa?.palabras ?? fase.palabras } : null,
    voz: vozGuardada?.parrafos?.length ? vozGuardada : null,
  };
}

// ── Avisos de redacción al guardar ──────────────────────────────────────────

/**
 * Lo que se ve del capítulo recién guardado, y las muletillas de toda la tesis:
 * una misma pieza puede estar bien en cada capítulo y repetirse en todos.
 */
async function avisosDeRedaccion(userId, productCode, capitulo) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  if (!proyecto) return [];
  const capitulos = await capitulosConTexto(proyecto);
  const este = capitulos.find((c) => c.code === capitulo);
  if (!este) return [];

  const avisos = controles.avisosDeCapitulo(prosa(este.texto).map((b) => quitarMarcas(b.texto).trim()));
  const todas = capitulos.flatMap((c) => prosa(c.texto).map((b) => quitarMarcas(b.texto)));
  const muletillas = controles.muletillas(todas).slice(0, 5);
  if (muletillas.length > 0) {
    avisos.push(
      `Muletillas en toda la tesis: ${muletillas.map((m) => `«${m.frase}» ${m.veces}`).join(', ')}. Varíalas en lo que ` +
        'escribas desde aquí.',
    );
  }
  return avisos.slice(0, 8);
}

module.exports = {
  bloques,
  prosa,
  capituloNumerado,
  reescribirParrafos,
  loMarcadoEnCapitulos,
  recordarVozDelReporte,
  recordarVozDelAvance,
  voz,
  contextoDeRedaccion,
  avisosDeRedaccion,
  ORDEN,
};

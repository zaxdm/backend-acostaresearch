'use strict';

const prisma = require('../../lib/prisma');
const openalex = require('../references/openalex.client');
const { AppError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');
const { construirRed, clave, recuentoDeUnidades, umbralPropuesto } = require('./mapas.red');
const { terminosDeLosDocumentos, frasesNominales, ocurrenciasDeTerminos } = require('./mapas.terminos');
const cache = require('./mapas.cache');

/**
 * Los mapas de VOSviewer: qué análisis, con qué unidad y de dónde salen los datos.
 *
 * LOS ANÁLISIS SON LOS DEL ASISTENTE «CREATE MAP» DE VOSVIEWER
 * -----------------------------------------------------------
 *   Coocurrencia       palabras clave
 *   Coautoría          autores · instituciones · países
 *   Citación           documentos · fuentes · autores · instituciones · países
 *   Acoplamiento       documentos · fuentes · autores · instituciones · países
 *   Cocitación         referencias citadas
 *   Términos           del título y el resumen (el «text data» de VOSviewer)
 *
 * Falta la cocitación de fuentes y de autores citados: VOSviewer la saca del
 * texto de cada referencia del export de Web of Science, y aquí habría que
 * pedir a OpenAlex los datos de decenas de miles de referencias por mapa.
 *
 * DOS ORÍGENES, Y NINGUNO ES SCOPUS
 * ---------------------------------
 *   - «openalex»: una búsqueda por tema. Datos CC0, que se pueden publicar en
 *     una tesis sin pedir permiso a nadie.
 *   - «mis-fuentes»: lo que el tesista subió de su export. Las palabras clave
 *     de autor y los resúmenes salen de ahí; lo demás (autores con afiliación,
 *     revista, referencias) se completa en OpenAlex por el DOI.
 *
 * El buscador de Scopus por API no alimenta los mapas: armar un producto
 * derivado con su contenido es justo lo que el acuerdo de Elsevier no deja.
 */

/** Por debajo de esto no sale un mapa que diga algo. */
const MINIMO_DE_DOCUMENTOS = 5;

/** El tope de autores de VOSviewer para la coautoría: por defecto, 25. */
const MAX_AUTORES_POR_DEFECTO = 25;

/**
 * Qué unidades admite cada análisis, qué enlace usa y qué campos de OpenAlex
 * necesita cada unidad.
 */
const ANALISIS = {
  coocurrencia: { enlace: 'coocurrencia', unidades: ['palabras-autor', 'palabras-openalex'] },
  coautoria: { enlace: 'coocurrencia', unidades: ['autores', 'instituciones', 'paises'] },
  citacion: { enlace: 'citacion', unidades: ['documentos', 'fuentes', 'autores', 'instituciones', 'paises'] },
  acoplamiento: {
    enlace: 'acoplamiento',
    unidades: ['documentos', 'fuentes', 'autores', 'instituciones', 'paises'],
  },
  cocitacion: { enlace: 'coocurrencia', unidades: ['referencias'] },
  terminos: { enlace: 'coocurrencia', unidades: ['titulo-resumen', 'titulo'] },
};

/** Cómo se llaman los círculos en el visor: [singular, plural]. */
const NOMBRE_DE_UNIDAD = {
  'palabras-autor': ['Palabra clave', 'Palabras clave'],
  'palabras-openalex': ['Palabra clave', 'Palabras clave'],
  autores: ['Autor', 'Autores'],
  instituciones: ['Institución', 'Instituciones'],
  paises: ['País', 'Países'],
  fuentes: ['Fuente', 'Fuentes'],
  documentos: ['Documento', 'Documentos'],
  referencias: ['Referencia citada', 'Referencias citadas'],
  'titulo-resumen': ['Término', 'Términos'],
  titulo: ['Término', 'Términos'],
};

const PERFIL_DE_UNIDAD = {
  'palabras-autor': 'terminos',
  'palabras-openalex': 'terminos',
  'titulo-resumen': 'terminos',
  titulo: 'terminos',
  autores: 'unidades',
  instituciones: 'unidades',
  paises: 'unidades',
  fuentes: 'unidades',
  documentos: 'documentos',
  referencias: 'referencias',
};

/** Qué pedirle a OpenAlex para cada análisis y unidad. */
function camposNecesarios(analisis, unidad) {
  const campos = new Set();
  if (unidad === 'palabras-openalex') campos.add('palabras');
  if (['autores', 'instituciones', 'paises', 'documentos'].includes(unidad)) campos.add('autores');
  if (unidad === 'fuentes') campos.add('fuente');
  if (['citacion', 'acoplamiento', 'cocitacion'].includes(analisis)) campos.add('referencias');
  if (unidad === 'titulo-resumen') campos.add('texto');
  return [...campos];
}

const nombrePais = (() => {
  let nombres = null;
  try {
    nombres = new Intl.DisplayNames(['es'], { type: 'region' });
  } catch {
    // Sin datos de idioma en el servidor, el código ISO sirve igual.
  }
  return (codigo) => {
    try {
      return nombres?.of(String(codigo).toUpperCase()) ?? codigo;
    } catch {
      return codigo;
    }
  };
})();

/** «Larcker, D.» → «Larcker». Lo que va en la etiqueta de un documento. */
const apellido = (autor) => String(autor ?? '').split(',')[0].trim() || 'Anónimo';

/** Las palabras clave de sus fuentes, que se guardan como «a, b, c». */
function terminosDeEtiquetas(tags) {
  return String(tags ?? '')
    .split(/\s*[,;]\s*/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function catalogoCaido() {
  return new AppError(
    'El catálogo abierto (OpenAlex) no está respondiendo ahora. Inténtalo de nuevo en unos minutos.',
    // Con su propio código: SERVICE_UNAVAILABLE pondría la web en mantenimiento.
    { statusCode: 503, code: ERROR_CODES.CATALOG_UNAVAILABLE },
  );
}

const noAlcanza = (mensaje) => new AppError(mensaje, { statusCode: 422, code: ERROR_CODES.VALIDATION_ERROR });

/**
 * Todo lo que puede necesitar cualquier análisis. Se pide de una vez para que
 * cambiar de análisis en el asistente no vuelva a consultar OpenAlex: el
 * resumen y las referencias pesan, pero una sola vez.
 */
const TODOS_LOS_CAMPOS = ['palabras', 'autores', 'fuente', 'referencias', 'texto'];

/**
 * Las obras del mapa, del origen que sea, en la forma de `obraDelMapa`.
 *
 * Devuelve `{ obras, total, extra, clave }`. `extra` cuenta lo que el tesista
 * tiene que saber de sus fuentes: cuántas no tenían DOI o no estaban en
 * OpenAlex. `clave` identifica estas obras en la caché del asistente.
 *
 * Una búsqueda de OpenAlex se guarda para todos —son datos públicos, y dos
 * tesistas con el mismo tema no tienen por qué pagarla dos veces—; lo que sale
 * de las fuentes de alguien, solo para él, y cambia en cuanto sube o borra una.
 */
async function obtenerObras(userId, datos, campos) {
  if (datos.origen === 'openalex') {
    const clave = JSON.stringify([
      'openalex',
      datos.tema.toLowerCase(),
      datos.desdeAnio ?? null,
      datos.hastaAnio ?? null,
      datos.cuantas ?? 500,
    ]);
    const resultado = await cache.recordar(clave, async () => {
      const { obras, total, caida } = await openalex.obrasParaMapa({
        tema: datos.tema,
        desdeAnio: datos.desdeAnio,
        hastaAnio: datos.hastaAnio,
        cuantas: datos.cuantas,
        campos: TODOS_LOS_CAMPOS,
      });
      if (caida) throw catalogoCaido();
      return { obras, total, extra: {} };
    });
    return { ...resultado, clave };
  }

  const fuentes = await prisma.reference.findMany({
    where: { ownerUserId: userId },
    select: { title: true, abstract: true, tags: true, year: true, doi: true, updatedAt: true },
  });
  if (fuentes.length === 0) {
    throw noAlcanza('Todavía no tienes fuentes. Sube el export de Scopus o Web of Science y vuelve a intentarlo.');
  }
  const ultima = Math.max(...fuentes.map((f) => new Date(f.updatedAt).getTime()));

  // Lo que se hace con sus propios datos, sin salir a OpenAlex.
  const soloPropias = campos.length === 0 || campos.every((c) => c === 'texto');
  if (soloPropias) {
    const obras = fuentes.map((f, i) => ({
      id: `propia-${i}`,
      doi: f.doi,
      titulo: f.title ?? '',
      anio: f.year ?? null,
      citas: 0,
      palabrasAutor: terminosDeEtiquetas(f.tags),
      resumen: f.abstract ?? null,
    }));
    return {
      obras,
      total: fuentes.length,
      extra: { sinCitas: true },
      clave: JSON.stringify(['propias', userId, fuentes.length, ultima]),
    };
  }

  const conDoi = fuentes.map((f) => f.doi).filter(Boolean);
  if (conDoi.length === 0) {
    throw noAlcanza(
      'Ninguna de tus fuentes tiene DOI, y este análisis lo necesita para traer autores, revistas y referencias. Prueba con «Coocurrencia» o «Términos».',
    );
  }
  const clave = JSON.stringify(['doi', userId, fuentes.length, ultima]);
  const resultado = await cache.recordar(clave, async () => {
    const obras = await openalex.obrasPorDoi(conDoi, TODOS_LOS_CAMPOS);
    if (obras.length === 0) throw catalogoCaido();
    return {
      obras,
      total: fuentes.length,
      extra: { conDoi: conDoi.length, encontradas: obras.length, sinDoi: fuentes.length - conDoi.length },
    };
  });
  return { ...resultado, clave };
}

/** Las frases nominales de cada obra, extraídas una vez por conjunto de obras. */
function frasesDe(obras, claveObras, unidad) {
  return cache.recordar(`${claveObras}|frases|${unidad}`, () =>
    obras.map((o) =>
      frasesNominales(unidad === 'titulo' ? o.titulo : [o.titulo, o.resumen].filter(Boolean).join('. ')),
    ),
  );
}

/** El análisis y la unidad de lo que se pide, ya resueltos. */
function resolver(datos) {
  const analisis = datos.analisis;
  let unidad = datos.unidad ?? ANALISIS[analisis].unidades[0];
  // De una búsqueda no hay palabras de autor: solo las de OpenAlex.
  if (datos.origen === 'openalex' && unidad === 'palabras-autor') unidad = 'palabras-openalex';
  return { analisis, unidad };
}

/**
 * Las unidades de cada obra según la unidad de análisis. Devuelve los
 * documentos que entiende `construirRed`.
 */
function documentosPara(obras, unidad, { maxAutores, analisis }) {
  const unidades = (o) => {
    switch (unidad) {
      case 'palabras-autor':
        return (o.palabrasAutor ?? []).map((p) => ({ etiqueta: p }));
      case 'palabras-openalex':
        return (o.palabras ?? []).map((p) => ({ etiqueta: p }));
      case 'autores':
        // «Ignorar documentos con un gran número de autores», como VOSviewer:
        // un artículo de cien firmantes uniría a cien personas que no se conocen.
        if (analisis === 'coautoria' && o.nAutores > maxAutores) return [];
        return o.autores.map((a) => ({ etiqueta: a }));
      case 'instituciones':
        if (analisis === 'coautoria' && o.nAutores > maxAutores) return [];
        return o.instituciones.map((i) => ({ etiqueta: i }));
      case 'paises':
        if (analisis === 'coautoria' && o.nAutores > maxAutores) return [];
        return o.paises.map((p) => ({ clave: `pais-${p}`, etiqueta: nombrePais(p) }));
      case 'fuentes':
        return o.fuente ? [{ etiqueta: o.fuente }] : [];
      case 'documentos':
        return [
          {
            clave: o.id,
            etiqueta: `${apellido(o.autores[0])} (${o.anio ?? 's. f.'})`,
            descripcion: o.titulo,
            url: o.doi ? `https://doi.org/${o.doi}` : null,
            anio: o.anio,
          },
        ];
      default:
        return [];
    }
  };

  const documentos = obras.map((o) => ({
    id: o.id,
    anio: o.anio,
    citas: o.citas,
    referencias: o.referencias ?? [],
    unidades: unidades(o),
  }));

  // Dos documentos del mismo autor y año se distinguen con una letra, como en
  // VOSviewer y en APA: «Maslach (2001a)», «Maslach (2001b)».
  if (unidad === 'documentos') {
    const repetidas = new Map();
    for (const d of documentos) {
      const e = d.unidades[0].etiqueta;
      repetidas.set(e, (repetidas.get(e) ?? 0) + 1);
    }
    const vistas = new Map();
    for (const d of documentos) {
      const u = d.unidades[0];
      if (repetidas.get(u.etiqueta) < 2) continue;
      const n = vistas.get(u.etiqueta) ?? 0;
      vistas.set(u.etiqueta, n + 1);
      u.etiqueta = u.etiqueta.replace(/\)$/, `${String.fromCharCode(97 + (n % 26))})`);
    }
  }

  return documentos;
}

/**
 * El paso «Elegir el umbral» del asistente de VOSviewer.
 *
 * Devuelve cuántos documentos y citas tiene cada unidad —en pares, sin
 * nombres—, para que la pantalla diga mientras se escribe «de los 2 345
 * autores, 87 cumplen los umbrales», como el programa de escritorio. Y el
 * umbral que propondríamos si no se toca.
 */
async function umbral(userId, datos) {
  const { analisis, unidad } = resolver(datos);
  const campos = camposNecesarios(analisis, unidad);
  const { obras, total, extra, clave: claveObras } = await obtenerObras(userId, datos, campos);

  let pares;
  if (analisis === 'terminos') {
    const frases = await frasesDe(obras, claveObras, unidad);
    const recuento = datos.recuento === 'completo' ? 'completo' : 'binario';
    pares = ocurrenciasDeTerminos(frases, recuento).map((n) => [n, 0]);
  } else if (analisis === 'cocitacion') {
    const citadas = new Map();
    for (const o of obras) for (const r of new Set(o.referencias)) citadas.set(r, (citadas.get(r) ?? 0) + 1);
    pares = [...citadas.values()].map((n) => [n, 0]);
  } else {
    const documentos = documentosPara(obras, unidad, {
      maxAutores: datos.maxAutores ?? MAX_AUTORES_POR_DEFECTO,
      analisis,
    });
    pares = recuentoDeUnidades(documentos, { tesauro: datos.sinonimos, excluir: datos.excluir });
  }

  let propuesto = null;
  if (analisis === 'terminos') propuesto = Math.max(2, Math.min(10, umbralPropuesto(pares, 150)));
  else if (unidad !== 'documentos') propuesto = umbralPropuesto(pares, datos.maximo ?? 100);

  return {
    analisis,
    unidad,
    pares,
    propuesto,
    origen: { tipo: datos.origen, total, analizados: obras.length },
    detalle: extra,
  };
}

/**
 * La cocitación: las referencias más citadas por el conjunto, con su nombre.
 *
 * Las referencias llegan como identificadores de OpenAlex. Para ponerles
 * nombre —«Maslach (2001)»— se piden sus datos, pero solo de las que pueden
 * entrar al mapa (las más citadas, hasta seiscientas): pedir las decenas de
 * miles que cita un conjunto de mil artículos sería una tarde de peticiones.
 */
async function documentosDeCocitacion(obras, { minimo, maximo }) {
  const citadas = new Map();
  for (const o of obras) for (const r of new Set(o.referencias)) citadas.set(r, (citadas.get(r) ?? 0) + 1);

  const umbral = minimo ?? 2;
  const tope = Math.min(Math.max(maximo * 3, 100), 600);
  const candidatas = [...citadas]
    .filter(([, n]) => n >= umbral)
    .sort((a, b) => b[1] - a[1])
    .slice(0, tope)
    .map(([id]) => id);

  if (candidatas.length < 2) {
    throw noAlcanza(
      'Los artículos casi no comparten referencias. Amplía la búsqueda o baja el mínimo de citas.',
    );
  }

  const fichas = await openalex.obrasPorIds(candidatas, ['autores', 'fuente']);
  const porId = new Map(fichas.map((f) => [f.id, f]));

  const documentos = obras.map((o) => ({
    id: o.id,
    anio: o.anio,
    citas: o.citas,
    unidades: [...new Set(o.referencias)]
      .filter((r) => porId.has(r))
      .map((r) => {
        const f = porId.get(r);
        return {
          clave: r,
          etiqueta: `${apellido(f.autores[0])} (${f.anio ?? 's. f.'})`,
          descripcion: [f.titulo, f.fuente].filter(Boolean).join(' — '),
          url: f.doi ? `https://doi.org/${f.doi}` : null,
          anio: f.anio,
        };
      }),
  }));

  return { documentos, referenciasDistintas: citadas.size };
}

/** Un título que diga qué mapa es, para el visor y para el archivo. */
function tituloDelMapa(datos, unidad) {
  const nombres = {
    coocurrencia: 'Coocurrencia de palabras clave',
    coautoria: `Coautoría por ${NOMBRE_DE_UNIDAD[unidad][1].toLowerCase()}`,
    citacion: `Citación entre ${NOMBRE_DE_UNIDAD[unidad][1].toLowerCase()}`,
    acoplamiento: `Acoplamiento bibliográfico de ${NOMBRE_DE_UNIDAD[unidad][1].toLowerCase()}`,
    cocitacion: 'Cocitación de referencias',
    terminos: unidad === 'titulo' ? 'Términos de los títulos' : 'Términos de títulos y resúmenes',
  };
  const de = datos.origen === 'mis-fuentes' ? 'mis fuentes' : datos.tema;
  return `${nombres[datos.analisis]}: ${de}`;
}

/**
 * El mapa, listo para VOSviewer.
 *
 * `datos` viene validado por `mapaSchema`: el análisis y la unidad casan, y el
 * recuento es uno de los que admite el análisis.
 */
async function crearMapa(userId, datos) {
  const { analisis, unidad } = resolver(datos);
  const campos = camposNecesarios(analisis, unidad);
  const { obras, total, extra, clave: claveObras } = await obtenerObras(userId, datos, campos);
  const maximo = datos.maximo ?? 100;

  let documentos;
  const opciones = {
    enlace: ANALISIS[analisis].enlace,
    perfil: PERFIL_DE_UNIDAD[unidad],
    recuento: datos.recuento === 'fraccionado' ? 'fraccionado' : 'completo',
    minimo: datos.minimo ?? null,
    minimoCitas: datos.minimoCitas ?? 0,
    maximo,
    excluir: datos.excluir,
    tesauro: datos.sinonimos,
    nombreUnidad: NOMBRE_DE_UNIDAD[unidad],
    titulo: tituloDelMapa(datos, unidad),
    // Las que el tesista dejó marcadas en «Verificar»: son esas y ninguna más.
    ...(Array.isArray(datos.seleccion) && datos.seleccion.length > 0 && { seleccion: datos.seleccion }),
  };
  const detalle = { ...extra };

  if (analisis === 'terminos') {
    const frases = await frasesDe(obras, claveObras, unidad);
    const textos = obras.map(() => ({}));
    const t = terminosDeLosDocumentos(textos, {
      recuento: datos.recuento === 'completo' ? 'completo' : 'binario',
      minimo: datos.minimo ?? null,
      porcentaje: datos.relevancia ?? 60,
      cuantos: datos.cuantosTerminos ?? null,
      frases,
    });
    documentos = obras.map((o, i) => ({
      id: o.id,
      anio: o.anio,
      citas: o.citas,
      // Sin clave propia: se identifican por el texto normalizado, para que el
      // tesauro pueda fundir «burnout» y «burnout syndrome» en uno.
      unidades: t.terminosDe[i].map((term) => ({ etiqueta: term })),
    }));
    const porClave = (mapa) => new Map([...mapa].map(([term, n]) => [clave(term), n]));
    opciones.minimo = 1;
    opciones.recuento = 'completo';
    opciones.ocurrencias = porClave(t.ocurrencias);
    opciones.puntuacionExtra = { nombre: 'Relevancia', valores: porClave(t.relevancias) };
    Object.assign(detalle, {
      terminos: {
        distintos: t.distintos,
        minimo: t.minimo,
        minimoAutomatico: t.minimoAutomatico,
        candidatos: t.candidatos,
        seleccionados: t.seleccionados,
        // El real: con «número de términos» ya no es el 60 % de antemano.
        porcentaje: t.candidatos > 0 ? Math.round((t.seleccionados / t.candidatos) * 100) : 0,
        recuento: datos.recuento === 'completo' ? 'completo' : 'binario',
        conResumen: obras.filter((o) => o.resumen).length,
      },
    });
  } else if (analisis === 'cocitacion') {
    const c = await documentosDeCocitacion(obras, { minimo: datos.minimo ?? null, maximo });
    documentos = c.documentos;
    opciones.minimo = datos.minimo ?? 2;
    detalle.referenciasDistintas = c.referenciasDistintas;
  } else {
    documentos = documentosPara(obras, unidad, {
      maxAutores: datos.maxAutores ?? MAX_AUTORES_POR_DEFECTO,
      analisis,
    });
  }

  const conUnidades = documentos.filter((d) => d.unidades.length > 0).length;
  if (conUnidades < MINIMO_DE_DOCUMENTOS) {
    throw noAlcanza(
      datos.origen === 'mis-fuentes' && unidad === 'palabras-autor'
        ? `Solo ${conUnidades} de tus ${total} fuentes traen palabras clave, y hacen falta al menos ${MINIMO_DE_DOCUMENTOS}. Vuelve a exportar de Scopus marcando «Abstract & keywords».`
        : `Solo ${conUnidades} documentos tienen datos para este análisis, y hacen falta al menos ${MINIMO_DE_DOCUMENTOS}. Prueba con un tema más amplio o con otro tipo de análisis.`,
    );
  }

  const mapa = construirRed(documentos, opciones);

  if (mapa.resumen.enElMapa < 2) {
    throw noAlcanza(
      analisis === 'citacion'
        ? 'Casi ningún artículo del conjunto cita a otro del mismo conjunto. Prueba con «Acoplamiento bibliográfico», que no lo necesita, o con más artículos.'
        : 'Con ese umbral no queda ningún par enlazado. Baja el mínimo o amplía la búsqueda.',
    );
  }

  if (analisis === 'terminos') {
    mapa.resumen.minimo = detalle.terminos.minimo;
    mapa.resumen.minimoAutomatico = detalle.terminos.minimoAutomatico;
    mapa.resumen.unidadesDistintas = detalle.terminos.distintos;
    mapa.resumen.cumplenMinimo = detalle.terminos.candidatos;
  }

  return {
    ...mapa,
    analisis,
    unidad,
    recuento: analisis === 'terminos' ? detalle.terminos.recuento : opciones.recuento,
    perfil: PERFIL_DE_UNIDAD[unidad],
    detalle,
    origen: {
      tipo: datos.origen,
      total,
      analizados: obras.length,
      ...(datos.origen === 'openalex' && {
        tema: datos.tema,
        desdeAnio: datos.desdeAnio ?? null,
        hastaAnio: datos.hastaAnio ?? null,
      }),
    },
  };
}

module.exports = { crearMapa, umbral, terminosDeEtiquetas, ANALISIS, MINIMO_DE_DOCUMENTOS };

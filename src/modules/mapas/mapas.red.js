'use strict';

/**
 * Las redes bibliométricas de VOSviewer: coocurrencia, coautoría, citación,
 * acoplamiento bibliográfico y cocitación.
 *
 * QUÉ SE CALCULA AQUÍ Y QUÉ NO
 * ----------------------------
 * Aquí se cuenta: qué unidades hay (palabras, autores, países, documentos…),
 * sus pesos (documentos, citas, ocurrencias) y la fuerza de cada enlace. Es la
 * parte que depende de los datos y la que se comprueba con pruebas.
 *
 * La disposición en el plano y los clústeres NO se calculan aquí: los calcula
 * VOSviewer Online en el navegador, con el algoritmo del de escritorio, cuando
 * el JSON llega sin `x`, `y` ni `cluster`. El mapa del tesista es un mapa de
 * VOSviewer de verdad, y se cita como tal.
 *
 * LAS REGLAS SON LAS DEL MANUAL DE VOSVIEWER (1.6.20), A PROPÓSITO
 * ---------------------------------------------------------------
 * Un asesor que conozca VOSviewer va a preguntar «¿qué umbral usaste?, ¿recuento
 * completo o fraccionado?». La respuesta tiene que ser la misma que daría con el
 * programa de escritorio:
 *
 *   - Coocurrencia y coautoría: dos unidades del mismo documento se enlazan.
 *     Recuento completo: +1 por documento. Fraccionado: en un documento con n
 *     unidades, cada enlace vale 1/(n−1), así que los n−1 enlaces de cada una
 *     suman 1 y un artículo con cien autores no pesa cien veces más.
 *   - Citación: A y B se enlazan si un documento de A cita uno de B, o al revés.
 *   - Acoplamiento: A y B se enlazan por cada referencia que citan los dos. Al
 *     agregar (fuentes, autores, países) se suma sobre todos los pares de
 *     documentos, como dice el manual.
 *   - Cocitación: dos referencias se enlazan si las cita el mismo documento; es
 *     una coocurrencia de referencias.
 *   - Primero se exige un mínimo, y de lo que queda entran las unidades de
 *     mayor FUERZA TOTAL DE ENLACE, no las más frecuentes.
 *   - Citas normalizadas: las citas de un documento divididas por la media de
 *     las citas de los documentos del mismo año DEL CONJUNTO. Corrige que un
 *     artículo de 2015 ha tenido más tiempo para ser citado que uno de 2023.
 */

/** Cuántas unidades entran en el mapa si no se dice otra cosa. */
const MAXIMO_POR_DEFECTO = 100;

/**
 * Cuántas candidatas se llevan al cálculo de enlaces, como mucho.
 *
 * Con un mínimo bajo puede haber miles de autores que lo pasan, y el
 * acoplamiento crece con el cuadrado. Se quedan las más frecuentes —cinco
 * veces lo que cabe en el mapa—, que es de donde van a salir las elegidas.
 */
const TOPE_DE_CANDIDATAS = 2500;

/**
 * La clave con la que se juntan las variantes de una etiqueta.
 *
 * «Machine Learning», «machine learning» y «machine-learning» son lo mismo, y
 * en el mapa tienen que ser un solo círculo. Minúsculas, sin tildes, guiones y
 * barras como espacio. No se lematiza: «network» y «networks» quedan separados,
 * igual que en VOSviewer con palabras clave, y se unen con el tesauro.
 */
function clave(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/[^\p{L}\p{N}+#.&,' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.,'&]+|[.,'&]+$/g, '')
    .trim();
}

/**
 * Lo que se enseña de una unidad: tal como vino, sin nada que parezca HTML.
 *
 * Las etiquetas vienen de fuera —del export del tesista o de OpenAlex— y el
 * visor pinta descripciones con HTML. Un «<» no lo lleva ningún nombre de
 * verdad, así que se quita sin más.
 */
function etiqueta(texto) {
  return String(texto ?? '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/**
 * El tesauro, en cualquiera de las dos formas.
 *
 *   - La nuestra, una línea por par: «ai = artificial intelligence».
 *   - La de VOSviewer: un archivo con cabecera «label<TAB>replace by» y una
 *     línea por par separada por tabulador. Así el tesista puede subir el
 *     tesauro que ya tiene hecho para el programa de escritorio.
 *
 * Como en VOSviewer, un reemplazo VACÍO significa «ignorar esta etiqueta».
 * Devuelve un `Map` de clave a `{ clave, etiqueta }`, o a `null` si se ignora.
 * Las líneas que no tienen ninguna de las dos formas se saltan: un tesauro a
 * medio escribir no puede impedir que salga el mapa.
 */
function leerTesauro(texto) {
  const tabla = new Map();
  for (const linea of String(texto ?? '').split(/\r?\n/)) {
    let partes = null;
    if (linea.includes('\t')) partes = linea.split('\t');
    else if (linea.includes('=')) partes = linea.split('=');
    if (!partes || partes.length < 2) continue;

    const [de, a] = [partes[0].trim(), partes.slice(1).join(' ').trim()];
    if (!clave(de)) continue;
    // La cabecera del archivo de VOSviewer no es un par.
    if (clave(de) === 'label' && clave(a) === 'replace by') continue;

    tabla.set(clave(de), clave(a) ? { clave: clave(a), etiqueta: etiqueta(a) } : null);
  }
  return tabla;
}

/** Lo que el tesista quiere fuera, separado por comas, puntos y coma o líneas. */
function leerExcluidos(texto) {
  return new Set(
    String(texto ?? '')
      .split(/[;\r\n]+|,(?!\s*[a-z]\.)/i)
      .map(clave)
      .filter(Boolean),
  );
}

/**
 * El umbral de documentos cuando el tesista no dice cuál.
 *
 * El menor a partir de 2 con el que no pasan más unidades de las que caben en
 * el mapa. Con 1 entraría todo lo que salió una sola vez, que es ruido; y
 * subirlo más de lo necesario deja fuera unidades que sí caben.
 */
function umbralAutomatico(cuentas, maximo, desde = 2) {
  const valores = [...cuentas];
  let umbral = desde;
  while (valores.filter((n) => n >= umbral).length > maximo) umbral += 1;
  return umbral;
}

const redondear = (n, decimales = 2) => {
  const factor = 10 ** decimales;
  return Math.round(n * factor) / factor;
};

/**
 * Las citas normalizadas de cada documento: sus citas entre la media de las
 * del mismo año en el conjunto. Un año donde nadie tiene citas da 0, no NaN.
 */
function citasNormalizadas(documentos) {
  const porAnio = new Map();
  for (const d of documentos) {
    const a = porAnio.get(d.anio) ?? { suma: 0, n: 0 };
    porAnio.set(d.anio, { suma: a.suma + (d.citas || 0), n: a.n + 1 });
  }
  return documentos.map((d) => {
    const a = porAnio.get(d.anio);
    const media = a && a.n > 0 ? a.suma / a.n : 0;
    return media > 0 ? (d.citas || 0) / media : 0;
  });
}

/** Cómo se llaman los pesos y puntuaciones en el visor y en el archivo `map`. */
const NOMBRES = {
  ocurrencias: 'Ocurrencias',
  documentos: 'Documentos',
  citas: 'Citas',
  citasNorm: 'Citas normalizadas',
  enlaces: 'Enlaces',
  fuerza: 'Fuerza total de enlace',
  anio: 'Año promedio de publicación',
  anioDoc: 'Año de publicación',
  citasProm: 'Citas promedio',
  citasNormProm: 'Citas normalizadas promedio',
  relevancia: 'Relevancia',
};

/**
 * Qué pesos y puntuaciones lleva cada clase de unidad, en el orden de VOSviewer.
 *
 *   - terminos: palabras clave y términos del texto.
 *   - unidades: autores, instituciones, países y fuentes.
 *   - documentos: los artículos mismos (citación y acoplamiento).
 *   - referencias: lo citado (cocitación). Sus «citas» son las que recibe
 *     DENTRO del conjunto, que es lo que mide la cocitación.
 */
const PERFILES = {
  terminos: {
    pesos: ['enlaces', 'fuerza', 'ocurrencias'],
    puntuaciones: ['anio', 'citasProm', 'citasNormProm'],
    tamano: 'ocurrencias',
  },
  unidades: {
    pesos: ['enlaces', 'fuerza', 'documentos', 'citas', 'citasNorm'],
    puntuaciones: ['anio', 'citasProm', 'citasNormProm'],
    tamano: 'documentos',
  },
  documentos: {
    pesos: ['enlaces', 'fuerza', 'citas', 'citasNorm'],
    puntuaciones: ['anioDoc', 'citasProm', 'citasNormProm'],
    tamano: 'citas',
  },
  referencias: {
    pesos: ['enlaces', 'fuerza', 'citas'],
    puntuaciones: ['anioDoc'],
    tamano: 'citas',
  },
};

/** La terminología del visor según lo que son los círculos. */
function terminologia(singular, plural) {
  return {
    item: singular,
    items: plural,
    link: 'Enlace',
    links: 'Enlaces',
    cluster: 'Clúster',
    clusters: 'Clústeres',
    link_strength: 'Fuerza del enlace',
    total_link_strength: 'Fuerza total de enlace',
  };
}

/** Suma `w` al par `a|b`, siempre en el mismo orden. */
function sumarPar(pares, a, b, w) {
  if (a === b) return;
  const par = a < b ? `${a}${b}` : `${b}${a}`;
  pares.set(par, (pares.get(par) ?? 0) + w);
}

/**
 * Los enlaces entre las unidades de `validas`, según el tipo.
 *
 * `unidadesDe[i]` son las claves del documento i (todas, no solo las válidas:
 * el recuento fraccionado divide entre TODAS las del documento, como VOSviewer).
 */
function calcularEnlaces({ tipo, recuento, documentos, unidadesDe, validas }) {
  const pares = new Map();
  const fraccionado = recuento === 'fraccionado';

  if (tipo === 'coocurrencia') {
    unidadesDe.forEach((todas) => {
      const dentro = todas.filter((k) => validas.has(k));
      if (dentro.length < 2) return;
      const w = fraccionado ? 1 / (todas.length - 1) : 1;
      for (let i = 0; i < dentro.length; i += 1) {
        for (let j = i + 1; j < dentro.length; j += 1) sumarPar(pares, dentro[i], dentro[j], w);
      }
    });
    return pares;
  }

  if (tipo === 'citacion') {
    const indice = new Map(documentos.map((d, i) => [d.id, i]));
    documentos.forEach((d, i) => {
      const propias = unidadesDe[i].filter((k) => validas.has(k));
      if (propias.length === 0) return;
      for (const ref of new Set(d.referencias ?? [])) {
        const j = indice.get(ref);
        if (j === undefined || j === i) continue;
        const citadas = unidadesDe[j].filter((k) => validas.has(k));
        for (const a of propias) for (const b of citadas) sumarPar(pares, a, b, 1);
      }
    });
    return pares;
  }

  if (tipo === 'acoplamiento') {
    // Por cada referencia, qué documentos la citan. Dos documentos que citan la
    // misma suman 1 a cada par de sus unidades.
    const citantes = new Map();
    documentos.forEach((d, i) => {
      if (!unidadesDe[i].some((k) => validas.has(k))) return;
      for (const ref of new Set(d.referencias ?? [])) {
        if (!citantes.has(ref)) citantes.set(ref, []);
        citantes.get(ref).push(i);
      }
    });
    for (const docs of citantes.values()) {
      if (docs.length < 2) continue;
      for (let x = 0; x < docs.length; x += 1) {
        const ua = unidadesDe[docs[x]].filter((k) => validas.has(k));
        for (let y = x + 1; y < docs.length; y += 1) {
          const ub = unidadesDe[docs[y]].filter((k) => validas.has(k));
          for (const a of ua) for (const b of ub) sumarPar(pares, a, b, 1);
        }
      }
    }
    return pares;
  }

  throw new Error(`Tipo de enlace desconocido: ${tipo}`);
}

function fuerzaTotal(pares) {
  const fuerza = new Map();
  const enlaces = new Map();
  for (const [par, n] of pares) {
    const [a, b] = par.split('');
    fuerza.set(a, (fuerza.get(a) ?? 0) + n);
    fuerza.set(b, (fuerza.get(b) ?? 0) + n);
    enlaces.set(a, (enlaces.get(a) ?? 0) + 1);
    enlaces.set(b, (enlaces.get(b) ?? 0) + 1);
  }
  return { fuerza, enlaces };
}

/**
 * Las unidades de cada documento, ya pasadas por el tesauro y lo excluido, con
 * sus documentos, citas y años. Es lo primero que hace VOSviewer, antes de
 * aplicar ningún umbral, y lo comparten la red y el paso del umbral.
 */
function reunirUnidades(documentos, opciones = {}) {
  const excluidos = leerExcluidos(opciones.excluir);
  const tesauro = leerTesauro(opciones.tesauro);
  const norm = citasNormalizadas(documentos);

  // Por unidad: sus formas escritas, cuántos documentos, qué citas y años.
  const info = new Map();
  const unidadesDe = [];

  documentos.forEach((doc, i) => {
    const propias = [];
    for (const u of doc.unidades ?? []) {
      let k = u.clave ?? clave(u.etiqueta);
      let forma = etiqueta(u.etiqueta);
      if (!k || !forma) continue;

      const clTesauro = clave(u.etiqueta);
      if (tesauro.has(clTesauro)) {
        const reemplazo = tesauro.get(clTesauro);
        if (reemplazo === null) continue;
        k = u.clave ? k : reemplazo.clave;
        forma = reemplazo.etiqueta;
      }
      if (excluidos.has(k) || excluidos.has(clave(forma)) || propias.includes(k)) continue;

      propias.push(k);
      if (!info.has(k)) {
        info.set(k, {
          formas: new Map(),
          docs: 0,
          citas: 0,
          citasNorm: 0,
          anios: [],
          extra: u,
        });
      }
      const x = info.get(k);
      x.formas.set(forma, (x.formas.get(forma) ?? 0) + 1);
      x.docs += 1;
      x.citas += doc.citas || 0;
      x.citasNorm += norm[i];
      if (Number.isFinite(doc.anio)) x.anios.push(doc.anio);
    }
    unidadesDe.push(propias);
  });

  return { info, unidadesDe };
}

/**
 * Cuántos documentos y citas tiene cada unidad: lo que necesita el paso
 * «Elegir el umbral» para decir, mientras se escribe, cuántas lo cumplen.
 * Pares `[documentos, citas]`, sin nombres: son miles y no hacen falta.
 */
function recuentoDeUnidades(documentos, opciones = {}) {
  const { info } = reunirUnidades(documentos, opciones);
  return [...info.values()].map((x) => [x.docs, x.citas]);
}

/** El umbral automático, para proponerlo en el paso del umbral. */
function umbralPropuesto(pares, maximo = MAXIMO_POR_DEFECTO) {
  return umbralAutomatico(
    pares.map(([n]) => n),
    maximo * 3,
    2,
  );
}

/**
 * De los documentos a la red de VOSviewer.
 *
 * `documentos`: `[{ id, anio, citas, referencias?, unidades: [{ etiqueta, clave?, url?, descripcion?, anio? }] }]`.
 * Una unidad sin `clave` se identifica por su etiqueta normalizada, que es lo
 * que hace VOSviewer con palabras, autores y revistas. Documentos y
 * referencias traen la suya (su identificador), porque dos artículos pueden
 * llamarse igual.
 *
 * `opciones`:
 *   - `enlace`: 'coocurrencia' | 'citacion' | 'acoplamiento'.
 *   - `perfil`: 'terminos' | 'unidades' | 'documentos' | 'referencias'.
 *   - `recuento`: 'completo' | 'fraccionado' (solo coocurrencia).
 *   - `minimo`: documentos (u ocurrencias, o citas en referencias) que tiene
 *     que tener una unidad; nulo = automático. No aplica a documentos.
 *   - `minimoCitas`: citas que tiene que tener (unidades y documentos).
 *   - `maximo`, `excluir`, `tesauro`, `titulo`, `descripcion`.
 *   - `nombreUnidad`: `[singular, plural]` para el visor.
 *   - `puntuacionExtra`: `{ nombre, valores: Map<clave, número> }`, p. ej. la
 *     relevancia de los términos.
 *   - `ocurrencias`: `Map<clave, número>` que sustituye al número de
 *     documentos en el peso «Ocurrencias» (recuento completo de términos).
 */
function construirRed(documentos, opciones = {}) {
  const perfil = PERFILES[opciones.perfil ?? 'terminos'];
  const enlace = opciones.enlace ?? 'coocurrencia';
  const maximo = Math.min(Math.max(Number(opciones.maximo) || MAXIMO_POR_DEFECTO, 5), 1000);
  const esDocumentos = opciones.perfil === 'documentos';
  const esReferencias = opciones.perfil === 'referencias';

  const { info, unidadesDe } = reunirUnidades(documentos, opciones);

  // ── Selección, como en VOSviewer: umbral, y de lo que pasa, fuerza total ──
  const citasDe = (k) => (esReferencias ? info.get(k).docs : info.get(k).citas);
  const pedido = Number.isInteger(opciones.minimo) && opciones.minimo >= 1 ? opciones.minimo : null;
  const minimo = esDocumentos
    ? 1
    : (pedido ??
      umbralAutomatico(
        [...info.values()].map((x) => x.docs),
        maximo * 3,
        2,
      ));
  const minimoCitas =
    Number.isInteger(opciones.minimoCitas) && opciones.minimoCitas > 0 ? opciones.minimoCitas : 0;

  let candidatas = [...info.keys()].filter(
    (k) => info.get(k).docs >= minimo && (esReferencias || info.get(k).citas >= minimoCitas),
  );
  const cumplenMinimo = candidatas.length;
  if (candidatas.length > TOPE_DE_CANDIDATAS) {
    candidatas = candidatas
      .sort((a, b) => info.get(b).docs - info.get(a).docs || citasDe(b) - citasDe(a))
      .slice(0, TOPE_DE_CANDIDATAS);
  }

  const argumentos = {
    tipo: enlace,
    recuento: opciones.recuento,
    documentos,
    unidadesDe,
  };
  // «Verify selected items»: si el tesista ya eligió cuáles, son esas y
  // ninguna otra, sin volver a seleccionar por fuerza.
  const seleccion = Array.isArray(opciones.seleccion) ? new Set(opciones.seleccion) : null;
  const previa = seleccion
    ? null
    : fuerzaTotal(calcularEnlaces({ ...argumentos, validas: new Set(candidatas) }));
  const elegidas = seleccion
    ? new Set([...info.keys()].filter((k) => seleccion.has(k)))
    : new Set(
        candidatas
          .sort(
            (a, b) =>
              (previa.fuerza.get(b) ?? 0) - (previa.fuerza.get(a) ?? 0) ||
              info.get(b).docs - info.get(a).docs ||
              citasDe(b) - citasDe(a) ||
              a.localeCompare(b),
          )
          .slice(0, maximo),
      );

  // Los enlaces se recalculan SOLO entre las elegidas: es lo que enseña
  // VOSviewer, y los números del mapa tienen que cuadrar con los de la tabla.
  const pares = calcularEnlaces({ ...argumentos, validas: elegidas });
  const { fuerza, enlaces } = fuerzaTotal(pares);

  // Una unidad sin ningún enlace no tiene sitio en el mapa: se quedaría
  // flotando en una esquina. Se cuenta y se dice.
  const conectadas = [...elegidas].filter((k) => (enlaces.get(k) ?? 0) > 0);

  const formaMasUsada = (k) =>
    [...info.get(k).formas].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0];

  const extra = opciones.puntuacionExtra;
  const filas = conectadas
    .map((k) => {
      const x = info.get(k);
      const anios = x.anios;
      return {
        clave: k,
        etiqueta: formaMasUsada(k),
        url: x.extra.url ?? null,
        descripcion: x.extra.descripcion ?? null,
        documentos: x.docs,
        // Con recuento completo de términos, las ocurrencias son todas las
        // apariciones y no los documentos: las trae quien extrajo los términos.
        ocurrencias: opciones.ocurrencias?.get(k) ?? x.docs,
        citas: esReferencias ? x.docs : x.citas,
        citasNorm: redondear(x.citasNorm, 4),
        enlaces: enlaces.get(k) ?? 0,
        fuerza: redondear(fuerza.get(k) ?? 0, 4),
        anio:
          esReferencias || esDocumentos
            ? (x.extra.anio ?? anios[0] ?? null)
            : anios.length > 0
              ? redondear(anios.reduce((s, a) => s + a, 0) / anios.length)
              : null,
        citasProm: redondear(x.citas / x.docs),
        citasNormProm: redondear(x.citasNorm / x.docs, 4),
        ...(extra && { extra: redondear(extra.valores.get(k) ?? 0, 4) }),
      };
    })
    .sort(
      (a, b) =>
        (esDocumentos || esReferencias ? b.citas - a.citas : b.documentos - a.documentos) ||
        b.fuerza - a.fuerza ||
        a.etiqueta.localeCompare(b.etiqueta),
    );

  const idDe = new Map(filas.map((f, i) => [f.clave, i + 1]));
  const conAnio = filas.some((f) => f.anio !== null);

  const valor = (f, nombre) =>
    ({
      ocurrencias: f.ocurrencias,
      documentos: f.documentos,
      citas: f.citas,
      citasNorm: f.citasNorm,
      enlaces: f.enlaces,
      fuerza: f.fuerza,
      anio: f.anio,
      anioDoc: f.anio,
      citasProm: f.citasProm,
      citasNormProm: f.citasNormProm,
    })[nombre];

  const items = filas.map((f) => {
    const scores = {};
    for (const p of perfil.puntuaciones) {
      if (valor(f, p) !== null && valor(f, p) !== undefined) scores[NOMBRES[p]] = valor(f, p);
    }
    if (extra) scores[extra.nombre] = f.extra;
    return {
      id: idDe.get(f.clave),
      label: f.etiqueta,
      ...(f.descripcion && { description: etiqueta(f.descripcion) }),
      ...(f.url && /^https:\/\//.test(f.url) && { url: f.url }),
      weights: Object.fromEntries(perfil.pesos.map((p) => [NOMBRES[p], valor(f, p)])),
      scores,
    };
  });

  const links = [...pares]
    .map(([par, n]) => {
      const [x, y] = par.split('').map((k) => idDe.get(k));
      // Siempre del menor al mayor: el enlace no tiene sentido y así cada par sale una vez igual.
      return {
        source_id: Math.min(x, y),
        target_id: Math.max(x, y),
        strength: redondear(n, 4),
      };
    })
    .filter((l) => l.source_id && l.target_id && l.strength > 0)
    .sort((x, y) => x.source_id - y.source_id || x.target_id - y.target_id);

  const [singular, plural] = opciones.nombreUnidad ?? ['Término', 'Términos'];

  const vosviewer = {
    config: {
      terminology: terminologia(singular, plural),
      parameters: {
        item_size: NOMBRES[perfil.tamano],
        // Solo la parte conectada más grande, como sugiere VOSviewer. Sin esto
        // el visor pregunta en inglés qué hacer con las unidades sueltas.
        largest_component: true,
      },
    },
    network: { items, links },
    info: {
      title: etiqueta(opciones.titulo) || 'Mapa bibliométrico',
      description: etiqueta(opciones.descripcion) || '',
    },
  };

  return {
    vosviewer,
    resumen: {
      documentos: documentos.length,
      documentosConUnidades: unidadesDe.filter((u) => u.length > 0).length,
      unidadesDistintas: info.size,
      minimo,
      minimoAutomatico: !esDocumentos && pedido === null,
      minimoCitas,
      cumplenMinimo,
      enElMapa: filas.length,
      sinEnlaces: elegidas.size - filas.length,
      enlaces: links.length,
      fuerzaTotal: redondear(
        links.reduce((s, l) => s + l.strength, 0),
        2,
      ),
      conAnio,
      // La clave va: es con lo que el paso «Verificar» dice cuáles se quedan.
      filas: filas.map(({ descripcion: _d, ...resto }) => resto),
    },
    archivos: {
      mapa: archivoMapa(items, perfil, extra?.nombre),
      red: links.map((l) => `${l.source_id}\t${l.target_id}\t${l.strength}`).join('\n'),
    },
  };
}

/**
 * El archivo `map` del VOSviewer de escritorio: una fila por unidad, separada
 * por tabuladores, con las cabeceras `weight<…>` y `score<…>` que él reconoce.
 * Se abre con «Create map → Based on network data → Read data from VOSviewer
 * files», junto con el archivo `network`.
 */
function archivoMapa(items, perfil, nombreExtra) {
  const pesos = perfil.pesos.map((p) => NOMBRES[p]);
  const puntuaciones = [
    ...perfil.puntuaciones.map((p) => NOMBRES[p]).filter((n) => items.some((it) => n in it.scores)),
    ...(nombreExtra ? [nombreExtra] : []),
  ];
  const cabecera = [
    'id',
    'label',
    'url',
    ...pesos.map((n) => `weight<${n}>`),
    ...puntuaciones.map((n) => `score<${n}>`),
  ];
  // Un tabulador dentro de un campo partiría la fila.
  const limpio = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
  const filas = items.map((it) =>
    [
      it.id,
      limpio(it.label),
      limpio(it.url),
      ...pesos.map((n) => it.weights[n]),
      ...puntuaciones.map((n) => it.scores[n] ?? ''),
    ].join('\t'),
  );
  return [cabecera.join('\t'), ...filas].join('\n');
}

module.exports = {
  construirRed,
  recuentoDeUnidades,
  umbralPropuesto,
  clave,
  etiqueta,
  leerTesauro,
  leerExcluidos,
  citasNormalizadas,
  NOMBRES,
  MAXIMO_POR_DEFECTO,
};

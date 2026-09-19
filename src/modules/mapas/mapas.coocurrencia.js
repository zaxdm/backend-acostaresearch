'use strict';

/**
 * El mapa de coocurrencia de palabras clave, como lo arma VOSviewer.
 *
 * QUÉ SE CALCULA AQUÍ Y QUÉ NO
 * ----------------------------
 * Aquí se cuenta: cuántos documentos traen cada término (ocurrencias) y cuántos
 * traen cada par (la fuerza del enlace). Es la parte que depende de los datos y
 * la que se puede comprobar con una prueba.
 *
 * La disposición en el plano y los clústeres NO se calculan aquí. Los calcula
 * el propio VOSviewer Online en el navegador, con el mismo algoritmo que el de
 * escritorio (VOS para la disposición y Leiden para los clústeres), cuando el
 * JSON llega sin `x`, `y` ni `cluster`. Así el mapa del tesista es un mapa de
 * VOSviewer de verdad, que puede citar como tal, y no una imitación nuestra.
 *
 * LAS REGLAS SON LAS DE VOSVIEWER, A PROPÓSITO
 * --------------------------------------------
 *   - Recuento completo: un documento con los términos A y B suma 1 al enlace
 *     A–B, tenga los términos que tenga. Un término repetido en el mismo
 *     documento cuenta una vez.
 *   - Primero se exige un mínimo de ocurrencias, y de lo que queda se eligen
 *     los términos con mayor FUERZA TOTAL DE ENLACE, no los más frecuentes: un
 *     término frecuente que no se conecta con nada no dice nada del campo.
 *
 * Un asesor que conozca VOSviewer va a preguntar «¿qué umbral usaste?». La
 * respuesta tiene que ser la misma que daría con el programa de escritorio.
 */

/** Cuántos términos entran en el mapa si no se dice otra cosa. */
const MAXIMO_POR_DEFECTO = 100;

/** Cómo se llaman las cosas en el visor. Van en su panel y en sus leyendas. */
const TERMINOLOGIA = {
  item: 'Término',
  items: 'Términos',
  link: 'Enlace',
  links: 'Enlaces',
  cluster: 'Clúster',
  clusters: 'Clústeres',
  link_strength: 'Fuerza del enlace',
  total_link_strength: 'Fuerza total de enlace',
};

/**
 * Los nombres de los pesos y las puntuaciones. Son los que el visor ofrece en
 * «tamaño» y en la vista por superposición, y los que salen como cabecera en
 * el archivo `map` para el VOSviewer de escritorio.
 */
const PESO_OCURRENCIAS = 'Ocurrencias';
const PESO_ENLACES = 'Enlaces';
const PESO_FUERZA = 'Fuerza total de enlace';
const PUNTUACION_ANIO = 'Año promedio de publicación';
const PUNTUACION_CITAS = 'Citas promedio';

/**
 * La clave con la que se juntan las variantes de un término.
 *
 * «Machine Learning», «machine learning» y «machine-learning» son el mismo
 * término, y en el mapa tienen que ser un solo círculo. Minúsculas, sin tildes,
 * guiones y barras como espacio. No se lematiza: «network» y «networks» quedan
 * separados, igual que en VOSviewer, y se unen con un sinónimo si hace falta.
 */
function clave(termino) {
  return String(termino ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/[^\p{L}\p{N}+#.&' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.'&]+|[.'&]+$/g, '')
    .trim();
}

/**
 * Lo que se enseña de un término: tal como vino, sin nada que parezca HTML.
 *
 * Las palabras clave vienen de fuera —del export del tesista o de OpenAlex— y
 * el visor pinta descripciones con HTML. Un «<» no lo lleva ninguna palabra
 * clave de verdad, así que se quita sin más.
 */
function etiqueta(termino) {
  return String(termino ?? '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * Los sinónimos que escribe el tesista, una línea cada uno: «de = a».
 *
 * Es el tesauro de VOSviewer en pequeño. «ai = artificial intelligence» junta
 * los dos en un solo término, que se llama como el lado derecho. Las líneas que
 * no tienen la forma se ignoran: un tesauro a medio escribir no puede impedir
 * que salga el mapa.
 */
function leerSinonimos(texto) {
  const tabla = new Map();
  for (const linea of String(texto ?? '').split(/\r?\n/)) {
    const partes = linea.split('=');
    if (partes.length !== 2) continue;
    const [de, a] = partes.map((p) => p.trim());
    if (!clave(de) || !clave(a)) continue;
    tabla.set(clave(de), { clave: clave(a), etiqueta: etiqueta(a) });
  }
  return tabla;
}

/** Los términos que el tesista quiere fuera, separados por comas o por líneas. */
function leerExcluidos(texto) {
  return new Set(
    String(texto ?? '')
      .split(/[,;\r\n]+/)
      .map(clave)
      .filter(Boolean),
  );
}

/**
 * El umbral de ocurrencias cuando el tesista no dice cuál.
 *
 * El menor a partir de 2 con el que no pasan más términos de los que caben en
 * el mapa. Con 1 entraría cualquier término que salió una sola vez, que es
 * ruido; y subirlo más de lo necesario deja fuera términos que sí caben.
 */
function umbralAutomatico(ocurrencias, maximo) {
  const valores = [...ocurrencias.values()];
  let umbral = 2;
  while (valores.filter((n) => n >= umbral).length > maximo) umbral += 1;
  return umbral;
}

const redondear = (n, decimales) => {
  const factor = 10 ** decimales;
  return Math.round(n * factor) / factor;
};

/**
 * Del conjunto de documentos al mapa.
 *
 * `documentos`: `[{ terminos: string[], anio?: number, citas?: number }]`.
 * `opciones`: `minimo` (nulo = automático), `maximo`, `excluir` y `sinonimos`
 * (texto tal como lo escribió el tesista), `titulo` y `descripcion`.
 *
 * Devuelve `{ vosviewer, resumen, archivos }`:
 *   - `vosviewer`: el JSON que abre VOSviewer Online (y el de escritorio).
 *   - `resumen`: los números para decirle al tesista qué salió.
 *   - `archivos`: `mapa` y `red`, el par de archivos de texto del VOSviewer de
 *     escritorio, para quien quiera retocar el mapa allí.
 */
function construirMapa(documentos, opciones = {}) {
  const maximo = Math.min(Math.max(Number(opciones.maximo) || MAXIMO_POR_DEFECTO, 5), 500);
  const excluidos = leerExcluidos(opciones.excluir);
  const sinonimos = leerSinonimos(opciones.sinonimos);

  // Cómo se escribe cada término, contando cuántas veces sale cada forma:
  // se enseña la más usada, no la primera que llegó.
  const formas = new Map();
  const ocurrencias = new Map();
  const anios = new Map();
  const citas = new Map();
  const conjuntos = [];
  let conTerminos = 0;

  for (const documento of documentos) {
    const propios = new Set();

    for (const bruto of documento.terminos ?? []) {
      let k = clave(bruto);
      if (!k) continue;

      let forma = etiqueta(bruto);
      const sinonimo = sinonimos.get(k);
      if (sinonimo) {
        k = sinonimo.clave;
        forma = sinonimo.etiqueta;
      }
      if (excluidos.has(k) || propios.has(k)) continue;

      propios.add(k);
      if (!formas.has(k)) formas.set(k, new Map());
      const cuentas = formas.get(k);
      cuentas.set(forma, (cuentas.get(forma) ?? 0) + 1);
    }

    if (propios.size === 0) continue;
    conTerminos += 1;
    conjuntos.push([...propios]);

    for (const k of propios) {
      ocurrencias.set(k, (ocurrencias.get(k) ?? 0) + 1);
      if (Number.isFinite(documento.anio)) {
        const a = anios.get(k) ?? { suma: 0, n: 0 };
        anios.set(k, { suma: a.suma + documento.anio, n: a.n + 1 });
      }
      const c = citas.get(k) ?? 0;
      citas.set(k, c + (Number(documento.citas) || 0));
    }
  }

  const pedido = Number.isInteger(opciones.minimo) && opciones.minimo >= 1 ? opciones.minimo : null;
  const minimo = pedido ?? umbralAutomatico(ocurrencias, maximo);
  const candidatos = new Set([...ocurrencias].filter(([, n]) => n >= minimo).map(([k]) => k));

  /** Cuántos documentos comparten cada par de candidatos. `a|b` con a < b. */
  const contarPares = (validos) => {
    const pares = new Map();
    for (const terminos of conjuntos) {
      const dentro = terminos.filter((k) => validos.has(k)).sort();
      for (let i = 0; i < dentro.length; i += 1) {
        for (let j = i + 1; j < dentro.length; j += 1) {
          const par = `${dentro[i]}|${dentro[j]}`;
          pares.set(par, (pares.get(par) ?? 0) + 1);
        }
      }
    }
    return pares;
  };

  const fuerzaTotal = (pares) => {
    const fuerza = new Map();
    for (const [par, n] of pares) {
      const [a, b] = par.split('|');
      fuerza.set(a, (fuerza.get(a) ?? 0) + n);
      fuerza.set(b, (fuerza.get(b) ?? 0) + n);
    }
    return fuerza;
  };

  // Los de mayor fuerza total de enlace; a igual fuerza, el más frecuente, y
  // después el orden alfabético para que el mismo corpus dé siempre el mismo mapa.
  const fuerzaCandidatos = fuerzaTotal(contarPares(candidatos));
  const elegidos = new Set(
    [...candidatos]
      .sort(
        (a, b) =>
          (fuerzaCandidatos.get(b) ?? 0) - (fuerzaCandidatos.get(a) ?? 0) ||
          ocurrencias.get(b) - ocurrencias.get(a) ||
          a.localeCompare(b),
      )
      .slice(0, maximo),
  );

  // Los enlaces y la fuerza se recalculan SOLO entre los elegidos: es lo que
  // enseña VOSviewer, y los números del mapa tienen que cuadrar con los de la tabla.
  const pares = contarPares(elegidos);
  const fuerza = fuerzaTotal(pares);
  const enlaces = new Map();
  for (const par of pares.keys()) {
    const [a, b] = par.split('|');
    enlaces.set(a, (enlaces.get(a) ?? 0) + 1);
    enlaces.set(b, (enlaces.get(b) ?? 0) + 1);
  }

  // Un término sin ningún enlace no tiene sitio en un mapa de coocurrencia:
  // se quedaría flotando en una esquina. Se cuenta y se dice.
  const conectados = [...elegidos].filter((k) => (enlaces.get(k) ?? 0) > 0);

  const formaMasUsada = (k) =>
    [...formas.get(k)].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0];

  const terminos = conectados
    .map((k) => {
      const a = anios.get(k);
      return {
        clave: k,
        termino: formaMasUsada(k),
        ocurrencias: ocurrencias.get(k),
        enlaces: enlaces.get(k) ?? 0,
        fuerza: fuerza.get(k) ?? 0,
        anioPromedio: a && a.n > 0 ? redondear(a.suma / a.n, 2) : null,
        citasPromedio: redondear((citas.get(k) ?? 0) / ocurrencias.get(k), 2),
      };
    })
    .sort((x, y) => y.ocurrencias - x.ocurrencias || y.fuerza - x.fuerza || x.termino.localeCompare(y.termino));

  const idDe = new Map(terminos.map((t, i) => [t.clave, i + 1]));
  const conAnio = terminos.some((t) => t.anioPromedio !== null);

  const items = terminos.map((t) => ({
    id: idDe.get(t.clave),
    label: t.termino,
    weights: {
      [PESO_ENLACES]: t.enlaces,
      [PESO_FUERZA]: t.fuerza,
      [PESO_OCURRENCIAS]: t.ocurrencias,
    },
    scores: {
      ...(t.anioPromedio !== null && { [PUNTUACION_ANIO]: t.anioPromedio }),
      [PUNTUACION_CITAS]: t.citasPromedio,
    },
  }));

  const links = [...pares]
    .map(([par, n]) => {
      const [a, b] = par.split('|');
      return { source_id: idDe.get(a), target_id: idDe.get(b), strength: n };
    })
    .filter((l) => l.source_id && l.target_id)
    .sort((x, y) => x.source_id - y.source_id || x.target_id - y.target_id);

  const vosviewer = {
    config: {
      terminology: TERMINOLOGIA,
      parameters: {
        item_size: PESO_OCURRENCIAS,
        // Solo la parte conectada más grande, como sugiere VOSviewer. Sin esto
        // el visor pregunta en inglés qué hacer con los términos sueltos.
        largest_component: true,
      },
    },
    network: { items, links },
    info: {
      title: etiqueta(opciones.titulo) || 'Mapa de coocurrencia de palabras clave',
      description: etiqueta(opciones.descripcion) || '',
    },
  };

  return {
    vosviewer,
    resumen: {
      documentos: documentos.length,
      documentosConTerminos: conTerminos,
      terminosDistintos: ocurrencias.size,
      minimo,
      minimoAutomatico: pedido === null,
      cumplenMinimo: candidatos.size,
      enElMapa: terminos.length,
      sinEnlaces: elegidos.size - terminos.length,
      enlaces: links.length,
      conAnio,
      terminos: terminos.map(({ clave: _clave, ...resto }) => resto),
    },
    archivos: {
      mapa: archivoMapa(items, conAnio),
      red: links.map((l) => `${l.source_id}\t${l.target_id}\t${l.strength}`).join('\n'),
    },
  };
}

/**
 * El archivo `map` del VOSviewer de escritorio: una fila por término,
 * separada por tabuladores, con las cabeceras `weight<…>` y `score<…>` que él
 * reconoce. Se abre con «Create map → Based on network data → Read data from
 * VOSviewer files», junto con el archivo `network`.
 */
function archivoMapa(items, conAnio) {
  const cabecera = [
    'id',
    'label',
    `weight<${PESO_ENLACES}>`,
    `weight<${PESO_FUERZA}>`,
    `weight<${PESO_OCURRENCIAS}>`,
    ...(conAnio ? [`score<${PUNTUACION_ANIO}>`] : []),
    `score<${PUNTUACION_CITAS}>`,
  ];

  const filas = items.map((it) =>
    [
      it.id,
      // Un tabulador dentro de la etiqueta partiría la fila.
      it.label.replace(/\t/g, ' '),
      it.weights[PESO_ENLACES],
      it.weights[PESO_FUERZA],
      it.weights[PESO_OCURRENCIAS],
      ...(conAnio ? [it.scores[PUNTUACION_ANIO] ?? ''] : []),
      it.scores[PUNTUACION_CITAS],
    ].join('\t'),
  );

  return [cabecera.join('\t'), ...filas].join('\n');
}

module.exports = { construirMapa, clave, leerSinonimos, leerExcluidos, MAXIMO_POR_DEFECTO };

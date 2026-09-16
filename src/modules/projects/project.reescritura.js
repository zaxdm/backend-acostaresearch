'use strict';

/**
 * Párrafos humanizados, escritos dentro del Word que subió el tesista.
 *
 * PARA QUÉ
 * --------
 * El humanizador reescribe prosa. Hasta ahora lo hacía en el chat, abriendo el
 * .docx con python-docx y cambiando `paragraph.text`: eso borra todas las
 * corridas del párrafo y deja una sola sin formato. Se perdían las cursivas de
 * los términos, la letra de la corrida, las llamadas a notas al pie y los
 * marcadores, y el tesista veía «que se le movía el formato». Además trabajaba
 * sobre una copia en el chat, no sobre el documento que tiene en el servidor.
 *
 * Aquí se hace al revés que python-docx: el párrafo conserva su `<w:p>` y su
 * `<w:pPr>` —estilo, sangría, interlineado, alineación—, y cada carácter del
 * texto nuevo toma el formato del carácter del original con el que se alinea.
 * Lo que es nuevo toma el de su alrededor si es el mismo a los dos lados, y si
 * no, el formato dominante del párrafo: una palabra añadida junto a una cursiva
 * no sale en cursiva.
 *
 * CÓMO SE ALINEA
 * --------------
 * Por palabras, con la subsecuencia común más larga entre el texto viejo y el
 * nuevo. Las palabras que siguen iguales se reconocen aunque cambie el orden de
 * lo de alrededor, y las llamadas a nota, marcadores y comentarios —que no son
 * texto— quedan detrás de la última palabra que seguía igual antes de ellas.
 *
 * QUÉ NO SE TOCA
 * --------------
 * Un párrafo con campos (citas de Zotero o Mendeley, referencias cruzadas),
 * hipervínculos, imágenes, ecuaciones, controles de contenido o control de
 * cambios no se reescribe: rehacer su texto a partir de las palabras rompería
 * lo que esas piezas guardan dentro. Se dice por qué y el tesista lo cambia en
 * su Word.
 *
 * PARTIR UN PÁRRAFO
 * -----------------
 * El humanizador puede partir un párrafo demasiado largo en dos, con el visto
 * bueno del autor. El texto nuevo trae entonces una línea en blanco donde va el
 * corte, y aquí sale como dos `<w:p>` con el mismo formato de párrafo. El salto
 * de sección y el salto de página antes, si los había, se quedan en el que les
 * toca: la sección en el último, el salto en el primero.
 */

const documento = require('./project.documento');

/** Donde va un punto y aparte en el texto nuevo. Claude también puede escribir la marca. */
const APARTE = /\s*\[APARTE\]\s*|[ \t]*\r?\n[ \t]*\r?\n\s*/gi;
const SEPARADOR = ' ';

/** Techo de la tabla de alineación: 16 millones de celdas son 32 MB, un párrafo de unas 4.000 palabras. */
const MAXIMO_CELDAS = 16_000_000;

class NoReescribible extends Error {}

// ── El párrafo por dentro ──────────────────────────────────────────────────

/** Lo que va dentro de un `<w:p>` y se conserva tal cual, en su sitio, aunque no sea texto. */
const ANCLAS_DE_PARRAFO = new Set([
  'w:bookmarkStart', 'w:bookmarkEnd', 'w:commentRangeStart', 'w:commentRangeEnd',
  'w:permStart', 'w:permEnd',
]);

/** Lo que va dentro de una corrida y se conserva en su sitio, dentro de una corrida con su formato. */
const ANCLAS_DE_CORRIDA = new Set([
  'w:footnoteReference', 'w:endnoteReference', 'w:commentReference', 'w:annotationRef',
  'w:footnoteRef', 'w:endnoteRef', 'w:separator', 'w:continuationSeparator',
]);

/** Lo que se descarta: marcas del corrector ortográfico y de la última paginación, que Word rehace. */
const DESECHABLES = new Set(['w:proofErr', 'w:lastRenderedPageBreak', 'w:softHyphen']);

/** Por qué no, en palabras del tesista. */
const MOTIVOS = {
  'w:fldChar': 'lleva un campo (una cita de Zotero o Mendeley, o una referencia cruzada)',
  'w:instrText': 'lleva un campo (una cita de Zotero o Mendeley, o una referencia cruzada)',
  'w:fldSimple': 'lleva un campo (una cita de Zotero o Mendeley, o una referencia cruzada)',
  'w:hyperlink': 'lleva un hipervínculo',
  'w:drawing': 'lleva una imagen o un cuadro de texto',
  'w:pict': 'lleva una imagen o un cuadro de texto',
  'w:object': 'lleva un objeto incrustado',
  'mc:AlternateContent': 'lleva una imagen o un cuadro de texto',
  'm:oMath': 'lleva una ecuación',
  'm:oMathPara': 'lleva una ecuación',
  'w:sdt': 'lleva un control de contenido',
  'w:ins': 'tiene control de cambios sin aceptar',
  'w:del': 'tiene control de cambios sin aceptar',
  'w:moveFrom': 'tiene control de cambios sin aceptar',
  'w:moveTo': 'tiene control de cambios sin aceptar',
  'w:delText': 'tiene control de cambios sin aceptar',
  'w:sym': 'lleva un símbolo especial',
};

/**
 * Las piezas de un párrafo: cada carácter visible con el formato de su corrida,
 * y las anclas con el número de caracteres que tienen delante.
 *
 * Lanza `NoReescribible` si el párrafo lleva algo que no se puede rehacer.
 */
function desmontar(xmlDelParrafo) {
  const piezas = [...xmlDelParrafo.matchAll(/<[^>]*>|[^<]+/g)].map((m) => m[0]);
  const apertura = piezas[0];
  if (!apertura || documento.nombreDe(apertura) !== 'w:p' || apertura.endsWith('/>')) {
    throw new NoReescribible('no tiene texto');
  }

  const unidades = [];
  const anclas = [];
  let pPr = '';
  let i = 1;

  /** Hasta el cierre de la etiqueta que abre en `piezas[desde]`, devuelto entero. */
  const bloque = (desde) => {
    const nombre = documento.nombreDe(piezas[desde]);
    if (piezas[desde].endsWith('/>')) return { xml: piezas[desde], hasta: desde + 1 };
    let profundidad = 0;
    for (let j = desde; j < piezas.length; j += 1) {
      const pieza = piezas[j];
      if (pieza[0] !== '<' || documento.nombreDe(pieza) !== nombre) continue;
      if (pieza.startsWith('</')) profundidad -= 1;
      else if (!pieza.endsWith('/>')) profundidad += 1;
      if (profundidad === 0) return { xml: piezas.slice(desde, j + 1).join(''), hasta: j + 1 };
    }
    throw new NoReescribible('está mal formado');
  };

  while (i < piezas.length - 1) {
    const pieza = piezas[i];
    if (pieza[0] !== '<') {
      i += 1;
      continue;
    }
    const nombre = documento.nombreDe(pieza);

    if (MOTIVOS[nombre]) throw new NoReescribible(MOTIVOS[nombre]);
    if (nombre === 'w:p') throw new NoReescribible('lleva un cuadro de texto');

    if (nombre === 'w:pPr') {
      const { xml, hasta } = bloque(i);
      pPr = xml;
      i = hasta;
      continue;
    }

    if (ANCLAS_DE_PARRAFO.has(nombre)) {
      const { xml, hasta } = bloque(i);
      anclas.push({ k: unidades.length, xml });
      i = hasta;
      continue;
    }

    if (DESECHABLES.has(nombre)) {
      i = bloque(i).hasta;
      continue;
    }

    if (nombre !== 'w:r') throw new NoReescribible(`lleva un elemento que no se puede rehacer (${nombre})`);

    const corrida = bloque(i);
    i = corrida.hasta;
    desmontarCorrida(corrida.xml, unidades, anclas);
  }

  return { apertura, pPr, unidades, anclas };
}

function desmontarCorrida(xmlDeCorrida, unidades, anclas) {
  const piezas = [...xmlDeCorrida.matchAll(/<[^>]*>|[^<]+/g)].map((m) => m[0]);
  let rPr = '';
  let j = 1;

  while (j < piezas.length - 1) {
    const pieza = piezas[j];
    if (pieza[0] !== '<') {
      j += 1;
      continue;
    }
    const nombre = documento.nombreDe(pieza);
    if (MOTIVOS[nombre]) throw new NoReescribible(MOTIVOS[nombre]);

    // Hasta el cierre de esta etiqueta.
    let hasta = j + 1;
    if (!pieza.endsWith('/>') && !pieza.startsWith('</')) {
      let profundidad = 0;
      for (let k = j; k < piezas.length; k += 1) {
        if (piezas[k][0] !== '<' || documento.nombreDe(piezas[k]) !== nombre) continue;
        if (piezas[k].startsWith('</')) profundidad -= 1;
        else if (!piezas[k].endsWith('/>')) profundidad += 1;
        if (profundidad === 0) {
          hasta = k + 1;
          break;
        }
      }
    }
    const entero = piezas.slice(j, hasta).join('');

    switch (true) {
      case nombre === 'w:rPr':
        rPr = entero;
        break;
      case nombre === 'w:t': {
        // Por unidades UTF-16, como se cuentan las posiciones del texto al alinear.
        const texto = documento.desescapar(piezas.slice(j + 1, hasta - 1).filter((x) => x[0] !== '<').join(''));
        for (let x = 0; x < texto.length; x += 1) unidades.push({ c: texto[x], rPr });
        break;
      }
      case nombre === 'w:tab':
        unidades.push({ c: '\t', rPr });
        break;
      case nombre === 'w:br' || nombre === 'w:cr':
        // Un salto de página o de columna no es un espacio: se queda en su sitio.
        if (/w:type="(page|column)"/.test(pieza)) anclas.push({ k: unidades.length, xml: `<w:r>${rPr}${entero}</w:r>` });
        else unidades.push({ c: '\n', rPr });
        break;
      case nombre === 'w:noBreakHyphen':
        unidades.push({ c: '-', rPr, xml: '<w:noBreakHyphen/>' });
        break;
      case ANCLAS_DE_CORRIDA.has(nombre):
        anclas.push({ k: unidades.length, xml: `<w:r>${rPr}${entero}</w:r>`, nota: /Reference$/.test(nombre) });
        break;
      case DESECHABLES.has(nombre):
        break;
      default:
        throw new NoReescribible(`lleva un elemento que no se puede rehacer (${nombre})`);
    }
    j = hasta;
  }
}

// ── Alinear lo viejo con lo nuevo ──────────────────────────────────────────

const TOKEN = /\s+|[\p{L}\p{N}\p{M}]+|[^\s\p{L}\p{N}\p{M}]/gu;

/** Las palabras, espacios y signos de un texto, con dónde empieza cada uno. */
function trocear(texto) {
  return [...texto.matchAll(TOKEN)].map((m) => ({
    t: m[0],
    desde: m.index,
    clave: /^\s+$/.test(m[0]) ? (m[0].includes('\t') ? '\t' : m[0].includes('\n') ? '\n' : ' ') : m[0],
  }));
}

/**
 * Para cada trozo nuevo, el índice del trozo viejo con el que se alinea, o -1.
 *
 * Lo común del principio y del final se aparta antes: casi todas las
 * reescrituras dejan algo igual en los bordes, y la tabla se hace solo con el medio.
 */
function alinear(viejos, nuevos) {
  const pareja = new Array(nuevos.length).fill(-1);
  let inicio = 0;
  while (inicio < viejos.length && inicio < nuevos.length && viejos[inicio].clave === nuevos[inicio].clave) {
    pareja[inicio] = inicio;
    inicio += 1;
  }
  let finV = viejos.length;
  let finN = nuevos.length;
  while (finV > inicio && finN > inicio && viejos[finV - 1].clave === nuevos[finN - 1].clave) {
    finV -= 1;
    finN -= 1;
    pareja[finN] = finV;
  }

  const n = finV - inicio;
  const m = finN - inicio;
  if (n === 0 || m === 0) return pareja;
  if ((n + 1) * (m + 1) > MAXIMO_CELDAS) {
    throw new NoReescribible('es demasiado largo para reescribirlo de una vez: pártelo antes en tu Word');
  }

  const ancho = m + 1;
  const tabla = new Uint16Array((n + 1) * ancho);
  for (let a = n - 1; a >= 0; a -= 1) {
    for (let b = m - 1; b >= 0; b -= 1) {
      tabla[a * ancho + b] =
        viejos[inicio + a].clave === nuevos[inicio + b].clave
          ? tabla[(a + 1) * ancho + b + 1] + 1
          : Math.max(tabla[(a + 1) * ancho + b], tabla[a * ancho + b + 1]);
    }
  }

  let a = 0;
  let b = 0;
  while (a < n && b < m) {
    if (viejos[inicio + a].clave === nuevos[inicio + b].clave) {
      pareja[inicio + b] = inicio + a;
      a += 1;
      b += 1;
    } else if (tabla[(a + 1) * ancho + b] >= tabla[a * ancho + b + 1]) {
      a += 1;
    } else {
      b += 1;
    }
  }
  return pareja;
}

// ── Montar el párrafo nuevo ────────────────────────────────────────────────

/** El texto nuevo, limpio: un separador por cada punto y aparte, sin espacios dobles ni caracteres que el XML no admite. */
function limpiar(texto, conSaltos) {
  const partes = String(texto)
    .replace(/[ --]/g, '')
    .split(APARTE)
    .map((parte) => {
      let limpia = parte.replace(/\r/g, '').replace(/ {2,}/g, ' ').trim();
      if (!conSaltos) limpia = limpia.replace(/\s*\n\s*/g, ' ');
      return limpia;
    })
    .filter((parte) => parte !== '');
  return partes.join(SEPARADOR);
}

const formatoDominante = (unidades) => {
  const cuenta = new Map();
  for (const u of unidades) if (!/\s/.test(u.c)) cuenta.set(u.rPr, (cuenta.get(u.rPr) ?? 0) + 1);
  let mejor = unidades[0]?.rPr ?? '';
  let maximo = -1;
  for (const [rPr, n] of cuenta) {
    if (n > maximo) {
      mejor = rPr;
      maximo = n;
    }
  }
  return mejor;
};

const corrida = (rPr, contenido) => `<w:r>${rPr}${contenido}</w:r>`;

/** Los caracteres del texto nuevo, cada uno con su formato, en corridas. */
function corridasDe(caracteres, anclasEn) {
  const salida = [];
  let tramo = '';
  let rPrDelTramo = null;

  const cerrarTramo = () => {
    if (tramo !== '') salida.push(corrida(rPrDelTramo, `<w:t xml:space="preserve">${documento.escaparXml(tramo)}</w:t>`));
    tramo = '';
    rPrDelTramo = null;
  };

  for (let i = 0; i <= caracteres.length; i += 1) {
    const anclas = anclasEn.get(i);
    if (anclas) {
      cerrarTramo();
      salida.push(...anclas);
    }
    if (i === caracteres.length) break;

    const { c, rPr, xml } = caracteres[i];
    if (c === '\t' || c === '\n' || xml) {
      cerrarTramo();
      salida.push(corrida(rPr, xml ?? (c === '\t' ? '<w:tab/>' : '<w:br/>')));
      continue;
    }
    if (rPr !== rPrDelTramo) cerrarTramo();
    rPrDelTramo = rPr;
    tramo += c;
  }
  cerrarTramo();
  return salida.join('');
}

/**
 * El XML que sustituye a un párrafo: uno, o varios si el texto nuevo trae
 * puntos y aparte. Devuelve también si el párrafo tenía llamadas a nota, que
 * conviene que el tesista mire.
 */
function rehacerParrafo(xmlDelParrafo, textoNuevo) {
  const { apertura, pPr, unidades, anclas } = desmontar(xmlDelParrafo);
  const viejo = unidades.map((u) => u.c).join('');
  const nuevo = limpiar(textoNuevo, viejo.includes('\n'));
  if (nuevo === '') throw new NoReescribible('el texto nuevo está vacío');

  const trozosViejos = trocear(viejo);
  const trozosNuevos = trocear(nuevo);
  const pareja = alinear(trozosViejos, trozosNuevos);
  const dominante = formatoDominante(unidades);

  // De qué carácter viejo sale cada carácter nuevo (-1 si es nuevo), y al revés.
  const origen = new Array(nuevo.length).fill(-1);
  const destino = new Array(viejo.length).fill(-1);
  trozosNuevos.forEach((trozo, t) => {
    const p = pareja[t];
    if (p === -1) return;
    const viejoT = trozosViejos[p];
    for (let d = 0; d < trozo.t.length; d += 1) {
      const u = viejoT.desde + Math.min(d, viejoT.t.length - 1);
      origen[trozo.desde + d] = u;
      if (d < viejoT.t.length) destino[u] = trozo.desde + d;
    }
  });

  const conFormato = [];
  let anterior = null;
  for (let i = 0; i < nuevo.length; i += 1) {
    const c = nuevo[i];
    if (c === SEPARADOR) {
      conFormato.push({ c, rPr: '' });
      continue;
    }
    const u = origen[i];
    if (u !== -1) {
      anterior = unidades[u];
      conFormato.push({ c, rPr: unidades[u].rPr, xml: unidades[u].c === c ? unidades[u].xml : undefined });
      continue;
    }
    let siguiente = null;
    for (let j = i + 1; j < nuevo.length && nuevo[j] !== SEPARADOR; j += 1) {
      if (origen[j] !== -1) {
        siguiente = unidades[origen[j]];
        break;
      }
    }
    const rPr = anterior && siguiente && anterior.rPr === siguiente.rPr ? anterior.rPr : dominante;
    conFormato.push({ c, rPr });
  }

  // Cada ancla, detrás del último carácter viejo anterior a ella que sigue en el texto nuevo.
  const anclasEn = new Map();
  for (const ancla of anclas) {
    let pos = 0;
    for (let u = ancla.k - 1; u >= 0; u -= 1) {
      if (destino[u] !== -1) {
        pos = destino[u] + 1;
        break;
      }
    }
    if (ancla.k > 0 && pos === 0) pos = ancla.k >= unidades.length ? nuevo.length : 0;
    if (!anclasEn.has(pos)) anclasEn.set(pos, []);
    anclasEn.get(pos).push(ancla.xml);
  }

  // Partir por los separadores, llevando las anclas a su parte.
  const partes = [];
  let desde = 0;
  for (let i = 0; i <= conFormato.length; i += 1) {
    if (i < conFormato.length && conFormato[i].c !== SEPARADOR) continue;
    // Un ancla justo en el corte se queda al final de la parte de antes.
    const suyas = new Map();
    for (const [pos, lista] of anclasEn) if (pos >= desde && pos <= i) suyas.set(pos - desde, lista);
    for (const pos of suyas.keys()) anclasEn.delete(pos + desde);
    partes.push(corridasDe(conFormato.slice(desde, i), suyas));
    desde = i + 1;
  }

  const xml = partes
    .map((contenido, n) => {
      const primera = n === 0;
      const ultima = n === partes.length - 1;
      const abre = primera ? apertura : apertura.replace(/\s+w14:(paraId|textId)="[^"]*"/g, '');
      let propiedades = pPr;
      if (!ultima) propiedades = propiedades.replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>|<w:sectPr\b[^>]*\/>/g, '');
      if (!primera) propiedades = propiedades.replace(/<w:pageBreakBefore\b[^>]*\/>/g, '');
      return `${abre}${propiedades}${contenido}</w:p>`;
    })
    .join('');

  return { xml, partes: partes.length, notas: anclas.some((a) => a.nota) };
}

// ── El documento entero ────────────────────────────────────────────────────

/**
 * Un probador para una tanda: abre el Word una vez y dice, para cada párrafo,
 * si se puede reescribir con ese texto (`motivo` null) o por qué no. Monta el
 * párrafo de prueba: lo que se acepta aquí es lo que se podrá descargar.
 */
function probador(buffer) {
  const { xml } = documento.abrir(buffer);
  const parrafos = new Map(documento.parrafosDe(xml).map((p) => [p.id, p]));

  return (id, textoNuevo) => {
    const parrafo = parrafos.get(Number(id));
    if (!parrafo) return { motivo: 'no hay ningún párrafo con ese número' };
    try {
      const hecho = rehacerParrafo(xml.slice(parrafo.inicio, parrafo.fin), textoNuevo);
      return { motivo: null, partes: hecho.partes, notas: hecho.notas };
    } catch (error) {
      if (error instanceof NoReescribible) return { motivo: `el párrafo ${error.message}` };
      throw error;
    }
  };
}

const probar = (buffer, id, textoNuevo) => probador(buffer)(id, textoNuevo);

/** «Uno. [APARTE] Dos.» → «Uno.\n\nDos.»: la marca que puede escribir Claude, como punto y aparte. */
const conApartes = (texto) =>
  String(texto)
    .split(APARTE)
    .map((parte) => parte.trim())
    .filter(Boolean)
    .join('\n\n');

/** Las partes de un texto humanizado, como salen en el Word. */
const partesDe = (texto) => conApartes(texto).split('\n\n');

/** Qué párrafos no se pueden reescribir, con su motivo, para avisarlo al leer. */
function bloqueados(buffer) {
  const { xml } = documento.abrir(buffer);
  const motivos = new Map();
  for (const parrafo of documento.parrafosDe(xml)) {
    if (!parrafo.texto.trim()) continue;
    try {
      desmontar(xml.slice(parrafo.inicio, parrafo.fin));
    } catch (error) {
      if (!(error instanceof NoReescribible)) throw error;
      motivos.set(parrafo.id, error.message);
    }
  }
  return motivos;
}

/**
 * El Word con los párrafos reescritos.
 *
 * `reescritos` es `{ id: { original, texto } }`. Un párrafo cuyo texto ya no es
 * `original` —porque el tesista subió otra versión— se salta: escribir encima
 * sería borrar lo que él cambió. Devuelve cuántas partes salió cada párrafo,
 * porque partir uno corre los números de todos los que van detrás.
 */
function reescribir(buffer, reescritos) {
  const { zip, xml } = documento.abrir(buffer);
  const parrafos = new Map(documento.parrafosDe(xml).map((p) => [p.id, p]));

  const ediciones = [];
  const partes = {};
  const saltados = [];

  for (const [id, { original, texto }] of Object.entries(reescritos ?? {})) {
    const parrafo = parrafos.get(Number(id));
    if (!parrafo || documento.esqueleto(parrafo.texto) !== documento.esqueleto(original)) {
      saltados.push(Number(id));
      continue;
    }
    try {
      const hecho = rehacerParrafo(xml.slice(parrafo.inicio, parrafo.fin), texto);
      ediciones.push({ desde: parrafo.inicio, hasta: parrafo.fin, poner: hecho.xml });
      partes[id] = hecho.partes;
    } catch (error) {
      if (!(error instanceof NoReescribible)) throw error;
      saltados.push(Number(id));
    }
  }

  ediciones.sort((a, b) => a.desde - b.desde);
  const trozos = [];
  let desde = 0;
  for (const edicion of ediciones) {
    trozos.push(xml.slice(desde, edicion.desde), edicion.poner);
    desde = edicion.hasta;
  }
  trozos.push(xml.slice(desde));

  zip.updateFile('word/document.xml', Buffer.from(trozos.join(''), 'utf8'));
  return { buffer: zip.toBuffer(), partes, saltados };
}

// ── Lo que el texto nuevo no puede cambiar ─────────────────────────────────

const CIFRAS = /\d+(?:[.,]\d+)*/g;
const COMILLAS = /«([^»]+)»|“([^”]+)”|"([^"]+)"/g;
const CORCHETES = /\[[^\]\n]*\]/g;
const CITA_ENTRE_PARENTESIS = /\(([^()]*\b(?:19|20)\d{2}[a-z]?\b[^()]*)\)/g;
const AUTOR_ANTES_DEL_ANIO =
  /(\p{Lu}[\p{L}'’-]+(?:\s+(?:y|e|and|&)\s+\p{Lu}[\p{L}'’-]+)?(?:\s+et\s+al\.)?)\s*\((?:19|20)\d{2}/gu;
const APELLIDO = /\b\p{Lu}[\p{L}'’-]{1,}/gu;

const contar = (lista) => {
  const cuenta = new Map();
  for (const x of lista) cuenta.set(x, (cuenta.get(x) ?? 0) + 1);
  return cuenta;
};

/** Los apellidos que aparecen citando: dentro de un paréntesis con año, o justo delante de «(año». */
function apellidosCitados(texto) {
  const apellidos = new Set();
  for (const m of texto.matchAll(CITA_ENTRE_PARENTESIS)) for (const a of m[1].matchAll(APELLIDO)) apellidos.add(a[0]);
  for (const m of texto.matchAll(AUTOR_ANTES_DEL_ANIO)) for (const a of m[1].matchAll(APELLIDO)) apellidos.add(a[0]);
  return apellidos;
}

/**
 * Null si la reescritura respeta lo que no se toca; si no, qué cambió.
 *
 * El humanizador reescribe la prosa, no los datos: las cifras (y con ellas los
 * años de las citas), lo que va entre comillas, los apellidos que se citan y lo
 * que va entre corchetes tienen que seguir ahí. Las marcas de cita [AR…] se
 * comprueban aparte, con las que el párrafo tenía guardadas.
 */
function comprobarReescritura(original, nuevo) {
  const limpio = documento.sinMarcas(String(nuevo).replace(APARTE, ' '));

  const antes = contar(original.match(CIFRAS) ?? []);
  const despues = contar(limpio.match(CIFRAS) ?? []);
  for (const [cifra, n] of antes) {
    if ((despues.get(cifra) ?? 0) < n) return `falta la cifra «${cifra}» del original: las cifras y los años no se cambian`;
  }
  for (const [cifra, n] of despues) {
    if ((antes.get(cifra) ?? 0) < n) return `aparece la cifra «${cifra}», que no está en el original: no se añaden datos`;
  }

  const esqueletoNuevo = documento.esqueleto(limpio);
  for (const m of original.matchAll(COMILLAS)) {
    const citado = m[1] ?? m[2] ?? m[3];
    if (!esqueletoNuevo.includes(documento.esqueleto(citado))) {
      return `cambió lo que va entre comillas («${citado.slice(0, 60)}»): una cita textual se copia tal cual`;
    }
  }

  const apellidosNuevos = new Set(limpio.match(APELLIDO) ?? []);
  for (const apellido of apellidosCitados(original)) {
    if (!apellidosNuevos.has(apellido)) return `falta «${apellido}», que está citado en el original`;
  }

  const corchetesOriginales = new Set((original.match(CORCHETES) ?? []).map(documento.esqueleto));
  for (const corchete of limpio.match(CORCHETES) ?? []) {
    if (!corchetesOriginales.has(documento.esqueleto(corchete))) {
      return `añade «${corchete}», que no está en el original: los avisos para el tesista van en el chat, no en su Word`;
    }
  }

  const largoAntes = documento.esqueleto(original).length;
  const largoDespues = esqueletoNuevo.length;
  if (largoAntes >= 80 && largoDespues < largoAntes * 0.35) {
    return 'el texto nuevo es menos de un tercio del original: humanizar no es resumir; si hay que quitar una idea, que lo decida el tesista y lo haga en su Word';
  }
  if (largoAntes >= 40 && largoDespues > largoAntes * 2.5) {
    return 'el texto nuevo es más del doble del original: humanizar no añade contenido';
  }

  return null;
}

module.exports = {
  reescribir,
  probar,
  probador,
  conApartes,
  partesDe,
  bloqueados,
  comprobarReescritura,
  rehacerParrafo,
  NoReescribible,
  APARTE,
};

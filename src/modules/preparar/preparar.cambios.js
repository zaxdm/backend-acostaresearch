'use strict';

/**
 * El texto corregido, escrito DENTRO del Word con control de cambios.
 *
 * PARA QUÉ
 * --------
 * La edición de inglés académico se entrega como la entregaría un editor
 * humano: cada palabra que se quitó, tachada; cada palabra que se puso,
 * subrayada; y el autor decide una por una en su Word con «Aceptar» y
 * «Rechazar». Devolver el texto ya cambiado, sin marcas, le obliga a comparar
 * dos documentos a mano para saber qué le tocaron, y a fiarse de que no le
 * cambiaron el sentido de una frase.
 *
 * QUÉ NO ES
 * ---------
 * No es «tachar el párrafo viejo y escribir el nuevo debajo». Eso también es
 * control de cambios y es inservible: un párrafo de ocho líneas saldría entero
 * tachado porque se corrigió un artículo. Aquí se compara palabra a palabra
 * —subsecuencia común más larga, lo mismo que usa `project.reescritura`— y
 * solo se marca lo que de verdad cambió.
 *
 * QUÉ SE CONSERVA
 * ---------------
 * El `<w:p>` del autor con su `<w:pPr>` entero: estilo, sangría, interlineado,
 * alineación, numeración. Y el formato de cada corrida: lo que se conserva y lo
 * que se tacha salen con la letra que tenían, así que una cursiva sigue en
 * cursiva aunque esté tachada. Lo que se añade toma el formato del texto donde
 * se inserta.
 *
 * LAS CITAS
 * ---------
 * Las citas de Zotero o Mendeley y los hipervínculos NO bloquean el párrafo: se
 * apartan antes de comparar y vuelven a su sitio después, con su campo entero,
 * para que Zotero siga pudiendo renumerar y rehacer la bibliografía. Ver
 * `preparar.campos`. Si una cita acabara dentro de un tachado, el párrafo se
 * deja como estaba: antes eso que entregar un Word con la cita movida.
 *
 * QUÉ NO SE TOCA
 * --------------
 * Un párrafo con imágenes, ecuaciones, notas al pie, símbolos, saltos de línea
 * o control de cambios ya puesto se deja EXACTAMENTE como está y se cuenta
 * aparte. Es más estricto que `project.reescritura`, que sí sabe recolocar una
 * llamada a nota al pie, y es a propósito: allí el texto nuevo es el mismo en
 * otro orden, y aquí hay que partirlo en trozos tachados y trozos puestos.
 * Colocar mal una nota al pie entre dos revisiones deja un Word que Word no
 * abre.
 *
 * Al cliente se le dice cuántos quedaron intactos y por qué.
 */

const documento = require('../projects/project.documento');
const campos = require('./preparar.campos');

/** Lo que hace que un párrafo no se pueda marcar, con el motivo para el cliente. */
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
  'w:ins': 'ya tiene control de cambios sin aceptar',
  'w:del': 'ya tiene control de cambios sin aceptar',
  'w:moveFrom': 'ya tiene control de cambios sin aceptar',
  'w:moveTo': 'ya tiene control de cambios sin aceptar',
  'w:delText': 'ya tiene control de cambios sin aceptar',
  'w:footnoteReference': 'lleva una llamada a nota al pie',
  'w:endnoteReference': 'lleva una llamada a nota al final',
  'w:sym': 'lleva un símbolo especial',
  'w:br': 'lleva un salto de línea dentro del párrafo',
  'w:tab': 'lleva una tabulación',
  'w:ptab': 'lleva una tabulación',
  'w:noBreakHyphen': 'lleva un guion de no separación',
};

/** Techo de la tabla de alineación, el mismo que en `project.reescritura`. */
const MAXIMO_CELDAS = 16_000_000;

/**
 * El identificador de la primera revisión.
 *
 * Alto a propósito: los `w:id` de las revisiones tienen que ser únicos dentro
 * del documento, y empezar en 1 se solaparía con los que pusiera cualquier otra
 * herramienta. Aquí solo entran documentos SIN revisiones —tenerlas bloquea el
 * párrafo—, así que no hay ninguno gastado de antes.
 */
const PRIMER_ID = 900_001;

/** Por qué no se puede marcar este párrafo. Null si sí se puede. */
function motivoDeBloqueo(xmlDelParrafo) {
  for (const etiqueta of xmlDelParrafo.matchAll(/<\/?\s*([\w:.-]+)/g)) {
    const motivo = MOTIVOS[etiqueta[1]];
    if (motivo) return motivo;
  }
  return null;
}

// ── Comparar palabra a palabra ─────────────────────────────────────────────

/**
 * El texto en trozos de «una palabra y los espacios que la siguen».
 *
 * Los espacios van PEGADOS a la palabra de delante, no sueltos: así, al quitar
 * una palabra se quita también su espacio y no queda un hueco doble, que es el
 * defecto clásico de los diffs por palabras.
 */
function trozos(texto) {
  const cadena = String(texto);
  const prefijo = (cadena.match(/^\s*/) || [''])[0];
  const lista = [];
  for (const encaje of cadena.matchAll(/\S+\s*/g)) {
    lista.push({
      desde: encaje.index,
      hasta: encaje.index + encaje[0].length,
      palabra: encaje[0].trimEnd(),
    });
  }
  return { prefijo, lista };
}

/**
 * Qué trozos de `a` y de `b` son el mismo, por subsecuencia común más larga.
 *
 * Devuelve pares `[i, j]` en orden. Si la tabla no cabe, se devuelve vacío: el
 * párrafo sale entero tachado y entero puesto, que es feo pero correcto, y solo
 * pasa con párrafos de miles de palabras.
 */
function comunes(a, b) {
  if (a.length === 0 || b.length === 0) return [];
  if ((a.length + 1) * (b.length + 1) > MAXIMO_CELDAS) return [];

  const ancho = b.length + 1;
  const tabla = new Int32Array((a.length + 1) * ancho);

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      tabla[i * ancho + j] =
        a[i].palabra === b[j].palabra
          ? tabla[(i + 1) * ancho + j + 1] + 1
          : Math.max(tabla[(i + 1) * ancho + j], tabla[i * ancho + j + 1]);
    }
  }

  const pares = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].palabra === b[j].palabra) {
      pares.push([i, j]);
      i += 1;
      j += 1;
    } else if (tabla[(i + 1) * ancho + j] >= tabla[i * ancho + j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pares;
}

/**
 * Las operaciones que llevan del texto viejo al nuevo, en orden.
 *
 * Cada una es `{ tipo, aDesde, aHasta, bDesde, bHasta }` en posiciones de
 * carácter: `igual` conserva, `quitar` tacha, `poner` añade. Las consecutivas
 * del mismo tipo salen ya juntas, porque cada operación será una revisión en el
 * Word y tres tachados seguidos son tres clics donde debería haber uno.
 */
function operaciones(textoViejo, textoNuevo) {
  const a = trozos(textoViejo);
  const b = trozos(textoNuevo);
  const pares = comunes(a.lista, b.lista);

  const pasos = [];
  const empujar = (tipo, aDesde, aHasta, bDesde, bHasta) => {
    if (aDesde === aHasta && bDesde === bHasta) return;
    const ultimo = pasos.at(-1);
    if (ultimo && ultimo.tipo === tipo) {
      ultimo.aHasta = aHasta;
      ultimo.bHasta = bHasta;
      return;
    }
    pasos.push({ tipo, aDesde, aHasta, bDesde, bHasta });
  };

  // El espacio del principio se conserva: no es una palabra, y tacharlo solo
  // ensuciaría el margen izquierdo de la revisión.
  empujar('igual', 0, a.prefijo.length, 0, b.prefijo.length);

  let i = 0;
  let j = 0;

  const alcanzar = (hastaI, hastaJ) => {
    if (i < hastaI) {
      const corte = a.lista[hastaI - 1].hasta;
      const enNuevo = b.lista[j]?.desde ?? String(textoNuevo).length;
      empujar('quitar', a.lista[i].desde, corte, enNuevo, enNuevo);
      i = hastaI;
    }
    if (j < hastaJ) {
      const enViejo = a.lista[i]?.desde ?? String(textoViejo).length;
      empujar('poner', enViejo, enViejo, b.lista[j].desde, b.lista[hastaJ - 1].hasta);
      j = hastaJ;
    }
  };

  for (const [posicionA, posicionB] of pares) {
    alcanzar(posicionA, posicionB);
    empujar('igual', a.lista[i].desde, a.lista[i].hasta, b.lista[j].desde, b.lista[j].hasta);
    i += 1;
    j += 1;
  }
  alcanzar(a.lista.length, b.lista.length);

  return pasos;
}

// ── Escribirlo en el Word ──────────────────────────────────────────────────

/** Las piezas del párrafo que son texto de verdad, con el formato de su corrida. */
const soloTexto = (piezas) => piezas.filter((pieza) => pieza.tipo === 'texto');

/** El formato de la corrida que cubre esa posición; pasado el final, el de la última. */
function formatoEn(piezas, posicion) {
  let ultimo = '';
  for (const pieza of piezas) {
    const rPr = pieza.nodo?.corrida?.rPr ?? '';
    if (posicion < pieza.desde + pieza.texto.length) return rPr;
    ultimo = rPr;
  }
  return ultimo;
}

/** Las corridas que cubren `[desde, hasta)` del texto del párrafo, con su formato original. */
function corridasDe(piezas, desde, hasta, etiqueta) {
  const salida = [];
  for (const pieza of piezas) {
    const inicio = Math.max(desde, pieza.desde);
    const fin = Math.min(hasta, pieza.desde + pieza.texto.length);
    if (fin <= inicio) continue;

    const trozo = pieza.texto.slice(inicio - pieza.desde, fin - pieza.desde);
    if (trozo === '') continue;

    salida.push(
      `<w:r>${pieza.nodo?.corrida?.rPr ?? ''}` +
        `<${etiqueta} xml:space="preserve">${documento.escaparXml(trozo)}</${etiqueta}></w:r>`,
    );
  }
  return salida.join('');
}

/** La etiqueta de apertura del `<w:p>` y su `<w:pPr>`, tal y como los escribió el autor. */
function cabeceraDe(xmlDelParrafo) {
  const apertura = (xmlDelParrafo.match(/^<w:p(?:\s[^>]*)?>/) || [])[0];
  if (!apertura) return null;

  const resto = xmlDelParrafo.slice(apertura.length);
  const pPr = (resto.match(/^\s*<w:pPr(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:pPr>)/) || [''])[0];
  return { apertura, pPr };
}

const enIso = (fecha) => new Date(fecha).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * El `<w:p>` con las revisiones puestas, o null si no había nada que marcar.
 *
 * `siguienteId` es un contador compartido por todo el documento: cada `<w:ins>`
 * y cada `<w:del>` gasta uno, y tienen que ser distintos entre sí.
 */
function marcarParrafo({
  xmlDelParrafo,
  piezas,
  textoViejo,
  textoNuevo,
  autor,
  fecha,
  siguienteId,
}) {
  const cabecera = cabeceraDe(xmlDelParrafo);
  if (!cabecera) return null;

  const textos = soloTexto(piezas);
  const pasos = operaciones(textoViejo, textoNuevo);
  if (!pasos.some((paso) => paso.tipo !== 'igual')) return null;

  const atributos = () =>
    `w:id="${siguienteId()}" w:author="${documento.escaparXml(autor)}" w:date="${enIso(fecha)}"`;

  const cuerpo = pasos
    .map((paso) => {
      if (paso.tipo === 'igual') return corridasDe(textos, paso.aDesde, paso.aHasta, 'w:t');

      if (paso.tipo === 'quitar') {
        const dentro = corridasDe(textos, paso.aDesde, paso.aHasta, 'w:delText');
        return dentro === '' ? '' : `<w:del ${atributos()}>${dentro}</w:del>`;
      }

      const puesto = String(textoNuevo).slice(paso.bDesde, paso.bHasta);
      if (puesto === '') return '';

      return (
        `<w:ins ${atributos()}><w:r>${formatoEn(textos, paso.aDesde)}` +
        `<w:t xml:space="preserve">${documento.escaparXml(puesto)}</w:t></w:r></w:ins>`
      );
    })
    .join('');

  return `${cabecera.apertura}${cabecera.pPr}${cuerpo}</w:p>`;
}

/**
 * El Word con los párrafos corregidos y el control de cambios puesto.
 *
 * `cambios` es `{ id: { original, texto } }`, igual que en
 * `project.reescritura.reescribir`. Un párrafo cuyo texto ya no es `original`
 * se salta: escribir encima sería borrar lo que cambió el autor mientras tanto.
 *
 * Devuelve cuántos párrafos se tocaron y, de los que no, por qué.
 */
function aplicar(buffer, cambios, { autor = 'Acosta | IA & Research', fecha = new Date() } = {}) {
  const { zip, xml } = documento.abrir(buffer);
  const parrafos = new Map(documento.parrafosDe(xml).map((parrafo) => [parrafo.id, parrafo]));

  let proximo = PRIMER_ID;
  const siguienteId = () => proximo++;

  const ediciones = [];
  const intactos = new Map();

  for (const [clave, cambio] of Object.entries(cambios ?? {})) {
    const id = Number(clave);
    const parrafo = parrafos.get(id);

    if (!parrafo || documento.esqueleto(parrafo.texto) !== documento.esqueleto(cambio.original)) {
      intactos.set(id, 'cambió en el documento mientras se preparaba');
      continue;
    }

    // Las citas de Zotero y los hipervínculos se apartan antes de comparar y se
    // devuelven después. Sin esto, un párrafo con una sola cita se quedaba sin
    // corregir, y en una tesis eso es casi todo el documento. Ver
    // `preparar.campos`.
    let protegido;
    let piezas = parrafo.piezas;
    let textoViejo = parrafo.texto;
    let textoNuevo = cambio.texto;
    try {
      protegido = campos.proteger(xml.slice(parrafo.inicio, parrafo.fin));
      if (protegido.campos.length > 0) {
        const releido = documento.parrafosDe(protegido.xml)[0];
        piezas = releido.piezas;
        textoViejo = releido.texto;
        textoNuevo = campos.enmascarar(cambio.texto, protegido.campos);
      }
    } catch (error) {
      if (!(error instanceof campos.NoProtegible)) throw error;
      intactos.set(id, error.message);
      continue;
    }

    const motivo = motivoDeBloqueo(protegido.xml);
    if (motivo) {
      intactos.set(id, motivo);
      continue;
    }

    const hecho = marcarParrafo({
      xmlDelParrafo: protegido.xml,
      piezas,
      textoViejo,
      textoNuevo,
      autor,
      fecha,
      siguienteId,
    });
    // Null es que no había nada que marcar: el párrafo ya estaba bien escrito.
    if (!hecho) continue;

    let puesto;
    try {
      puesto = campos.restaurar(hecho, protegido.campos);
    } catch (error) {
      // La cita acabó dentro de un tachado o desapareció al comparar. Antes de
      // entregar un Word con una cita movida o perdida, se deja el párrafo.
      if (!(error instanceof campos.NoProtegible)) throw error;
      intactos.set(id, error.message);
      continue;
    }

    ediciones.push({ desde: parrafo.inicio, hasta: parrafo.fin, poner: puesto });
  }

  ediciones.sort((a, b) => a.desde - b.desde);

  const piezasXml = [];
  let desde = 0;
  for (const edicion of ediciones) {
    piezasXml.push(xml.slice(desde, edicion.desde), edicion.poner);
    desde = edicion.hasta;
  }
  piezasXml.push(xml.slice(desde));

  zip.updateFile('word/document.xml', Buffer.from(piezasXml.join(''), 'utf8'));

  return { buffer: zip.toBuffer(), tocados: ediciones.length, intactos };
}

module.exports = {
  aplicar,
  marcarParrafo,
  operaciones,
  motivoDeBloqueo,
  trozos,
  MOTIVOS,
  PRIMER_ID,
};

'use strict';

/**
 * Las citas de Zotero y los hipervínculos, a salvo mientras se reescribe.
 *
 * EL PROBLEMA
 * -----------
 * Un párrafo de tesis no es texto: es texto con cosas incrustadas. Una cita de
 * Zotero no es «(Ong et al., 2022)», es un campo de Word —`fldChar begin`, la
 * instrucción con el JSON del CSL, `separate`, el texto que se ve, `end`— y ese
 * JSON es lo que le permite a Zotero volver a numerar y rehacer la
 * bibliografía. Un hipervínculo es otro tanto: lo que se ve es texto, pero el
 * destino vive en el `<w:hyperlink>`.
 *
 * Tanto `project.reescritura` como `preparar.cambios` rehacen el párrafo a
 * partir de sus caracteres, y por eso se niegan a tocar uno que lleve un campo:
 * al recomponerlo por palabras, el campo se perdería. Para el humanizador eso
 * está bien —se salta ese párrafo y ya—, pero para TRADUCIR está mal: en una
 * tesis casi todos los párrafos de verdad llevan cita, y devolver la mitad del
 * documento en inglés y la mitad en español no le sirve a nadie.
 *
 * CÓMO SE RESUELVE
 * ----------------
 * Se saca el campo entero del párrafo y se deja en su lugar UN carácter que no
 * existe en ningún idioma (de la zona de uso privado de Unicode). El párrafo
 * pasa a ser texto corriente, así que el motor de siempre puede reescribirlo; y
 * el carácter viaja por la reescritura como una palabra más, colocándose donde
 * el texto nuevo pone la cita. Al final se cambia el carácter por el campo
 * entero, tal y como estaba, con su JSON intacto.
 *
 * Que el texto nuevo lleve la cita es lo que hace que esto funcione, y por eso
 * las instrucciones del modelo dicen que una cita se copia tal cual. Cuando no
 * la lleva —porque el modelo la tradujo o se la comió—, aquí no se adivina: se
 * dice que no se puede, y quien llama deja el párrafo como estaba. Colocar una
 * cita donde no va es peor que no traducir el párrafo.
 *
 * LAS PIEZAS OPACAS
 * -----------------
 * Una figura, una ecuación o un control de contenido (`reescritura.ANCLABLES`)
 * se sacan enteras y NO se miran por dentro, porque dentro puede haber justo
 * otro campo. Las que enseñan texto —un control de contenido con la cita de
 * Mendeley— se protegen como un campo más, que para eso tienen texto por el que
 * reconocerlas; las que no enseñan ninguno se dejan donde están y las coloca
 * `project.reescritura` por su posición.
 */

const documento = require('../projects/project.documento');
const reescritura = require('../projects/project.reescritura');

/**
 * El primer carácter de marca.
 *
 * Zona de uso privado: Unicode garantiza que ninguna lengua lo usa, así que no
 * puede aparecer por su cuenta en un documento ni en lo que devuelve el modelo.
 */
const PRIMERA_MARCA = 0xe000;

/** Tantas por párrafo. Con más, se deja el párrafo en paz: algo raro pasa ahí. */
const MAXIMO_CAMPOS = 64;

/** Un párrafo que no se puede proteger. Quien llama lo deja intacto. */
class NoProtegible extends Error {}

/**
 * Lo que se saca entero del párrafo sin mirarlo por dentro.
 *
 * Los hipervínculos y los campos de una sola etiqueta, porque lo que se ve es
 * texto pero lo que vale está en la etiqueta; y las piezas opacas de
 * `reescritura.ANCLABLES` —una figura, una ecuación, un control de contenido—,
 * porque dentro puede haber justo otro campo.
 */
const ENTERAS = new Set(reescritura.ANCLABLES);

const esMarca = (caracter) =>
  caracter.charCodeAt(0) >= PRIMERA_MARCA && caracter.charCodeAt(0) < PRIMERA_MARCA + MAXIMO_CAMPOS;

/** ¿Lleva este texto alguna marca? Sirve para no tocar lo que no la tiene. */
const llevaMarcas = (texto) => [...String(texto)].some(esMarca);

// ── Partir el párrafo ──────────────────────────────────────────────────────

/** Las etiquetas y los textos de un XML, en orden. */
const trocear = (xml) => [...String(xml).matchAll(/<[^>]*>|[^<]+/g)].map((m) => m[0]);

/**
 * El elemento que abre en `piezas[desde]`, entero, y por dónde sigue.
 *
 * Cuenta la profundidad por nombre: un `<w:r>` dentro de otro no existe, pero
 * un `<w:hyperlink>` puede llevar dentro lo que sea y hay que cerrarlo bien.
 */
function bloque(piezas, desde) {
  const nombre = documento.nombreDe(piezas[desde]);
  if (piezas[desde].endsWith('/>')) return { xml: piezas[desde], hasta: desde + 1 };

  let profundidad = 0;
  for (let i = desde; i < piezas.length; i += 1) {
    const pieza = piezas[i];
    if (pieza[0] !== '<' || documento.nombreDe(pieza) !== nombre) continue;
    if (pieza.startsWith('</')) profundidad -= 1;
    else if (!pieza.endsWith('/>')) profundidad += 1;
    if (profundidad === 0) return { xml: piezas.slice(desde, i + 1).join(''), hasta: i + 1 };
  }
  throw new NoProtegible('el párrafo está mal formado');
}

/** El texto que se ve de un trozo de XML: lo que hay dentro de sus `<w:t>`. */
function textoVisible(xml) {
  let texto = '';
  for (const encaje of String(xml).matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) {
    texto += documento.desescapar(encaje[1]);
  }
  return texto;
}

/**
 * El texto que enseña un campo: lo que va entre `separate` y `end`.
 *
 * Antes de `separate` está la instrucción, que no se ve. Un campo sin
 * `separate` —uno que Word nunca calculó— no enseña nada, y ese no se puede
 * proteger: no hay texto donde agarrarlo en la traducción.
 */
function resultadoDelCampo(xml) {
  const corte = xml.indexOf('w:fldCharType="separate"');
  if (corte === -1) return '';
  return textoVisible(xml.slice(corte));
}

/** El formato de la primera corrida de un trozo, para dárselo a la marca. */
const formatoDe = (xml) => (String(xml).match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];

/**
 * El párrafo con sus campos e hipervínculos sustituidos por una marca.
 *
 * Devuelve `{ xml, campos }`. Cada campo lleva su marca, su XML entero y el
 * texto que enseña, que es por donde se le reconocerá en el texto nuevo.
 */
function proteger(xmlDelParrafo) {
  const piezas = trocear(xmlDelParrafo);
  const salida = [];
  const campos = [];

  // Cuántos caracteres visibles van ya. Es lo que después permite saber que la
  // primera «(2024)» del párrafo es la primera y no la segunda.
  let vistos = 0;

  const anotar = (xml, texto) => {
    if (campos.length >= MAXIMO_CAMPOS) throw new NoProtegible('lleva demasiados campos');
    if (texto.trim() === '') throw new NoProtegible('lleva un campo que no enseña ningún texto');

    const marca = String.fromCharCode(PRIMERA_MARCA + campos.length);
    campos.push({ marca, xml, texto, desde: vistos });
    vistos += texto.length;
    salida.push(`<w:r>${formatoDe(xml)}<w:t xml:space="preserve">${marca}</w:t></w:r>`);
  };

  let i = 0;
  while (i < piezas.length) {
    const pieza = piezas[i];
    if (pieza[0] !== '<' || pieza.startsWith('</')) {
      salida.push(pieza);
      i += 1;
      continue;
    }

    const nombre = documento.nombreDe(pieza);

    // Una pieza que va entera o no va: un hipervínculo, una figura, una
    // ecuación, un control de contenido. Se saca ENTERA y NO se mira por
    // dentro; si no, un campo de Mendeley metido dentro de un control de
    // contenido se marcaría aquí y después la pieza volvería entera con la
    // marca dentro, que es una cita perdida.
    if (ENTERAS.has(nombre)) {
      const { xml, hasta } = bloque(piezas, i);
      const texto = textoVisible(xml);

      // Con texto a la vista, el modelo lo vio y lo devuelve: se protege como
      // un campo y se le reconoce por ese texto. Sin texto —una figura, una
      // ecuación, el número de página de un pie— no hay por dónde agarrarlo en
      // la traducción, así que se deja estar y lo coloca `project.reescritura`
      // por su posición.
      if (texto.trim() === '') salida.push(xml);
      else anotar(xml, texto);

      i = hasta;
      continue;
    }

    if (nombre !== 'w:r') {
      salida.push(pieza);
      i += 1;
      continue;
    }

    const corrida = bloque(piezas, i);

    // Una corrida normal se copia. Una que abre un campo arrastra a todas las
    // que van hasta su cierre: el campo es esa tira entera, no una etiqueta.
    if (!corrida.xml.includes('w:fldCharType="begin"')) {
      salida.push(corrida.xml);
      vistos += textoVisible(corrida.xml).length;
      i = corrida.hasta;
      continue;
    }

    let profundidad = 0;
    let j = i;
    let entero = '';
    while (j < piezas.length) {
      const otra = piezas[j][0] === '<' && documento.nombreDe(piezas[j]) === 'w:r' && !piezas[j].startsWith('</')
        ? bloque(piezas, j)
        : null;
      if (!otra) {
        j += 1;
        continue;
      }
      entero += otra.xml;
      if (otra.xml.includes('w:fldCharType="begin"')) profundidad += 1;
      if (otra.xml.includes('w:fldCharType="end"')) profundidad -= 1;
      j = otra.hasta;
      if (profundidad === 0) break;
    }
    if (profundidad !== 0) throw new NoProtegible('lleva un campo sin cerrar');

    const resultado = resultadoDelCampo(entero);
    if (resultado.trim() === '') salida.push(entero);
    else anotar(entero, resultado);
    i = j;
  }

  // Dónde caía cada campo, de 0 a 1. La traducción cambia el largo del párrafo,
  // así que lo que se compara después es la proporción, no el carácter exacto.
  for (const campo of campos) campo.relativo = vistos > 0 ? campo.desde / vistos : 0;

  return { xml: salida.join(''), campos };
}

// ── Poner la marca en el texto nuevo ───────────────────────────────────────

const ESCAPAR = /[.*+?^${}()|[\]\\]/g;

/** Guiones y comillas que se escriben de varias formas, a una sola. */
const EQUIVALENTES = {
  '“': '"', '”': '"', '„': '"', '«': '"', '»': '"',
  '‘': "'", '’': "'", '‚': "'", 'ʼ': "'",
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '−': '-',
};

/**
 * El texto con lo que el modelo cambia sin querer, igualado.
 *
 * El 24-sep-2026 un párrafo entero se quedó en español porque el modelo
 * escribió «Garcia‑Lopez» con el guion que no se parte (U+2011) —lo hace en
 * todo el texto: «sub‑characteristics», «5‑point»— y la cita del Word lleva el
 * guion de siempre. Lo mismo pasa con los apóstrofos («Ma’ruf») y con una tilde
 * puesta o quitada en un apellido. Nada de eso cambia la cita.
 *
 * Carácter a carácter y de uno a uno, para que las posiciones del texto
 * igualado sigan siendo las del texto nuevo.
 */
const igualar = (texto) =>
  [...String(texto)]
    .map((caracter) => {
      if (EQUIVALENTES[caracter]) return EQUIVALENTES[caracter];
      const base = caracter.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
      return base.length === caracter.length ? base : caracter;
    })
    .join('');

/** El texto del campo, como expresión que admite que los espacios cambien. */
const comoExpresion = (texto) =>
  new RegExp(
    igualar(texto)
      .trim()
      .split(/\s+/)
      .map((trozo) => trozo.replace(ESCAPAR, '\\$&'))
      .join('\\s+'),
    'g',
  );

/**
 * El texto nuevo con cada cita sustituida por su marca.
 *
 * POR QUÉ NO BASTA CON BUSCAR EL TEXTO
 * ------------------------------------
 * Porque una cita narrativa —«la Unión Internacional (2024) estima»— deja en el
 * campo solo «(2024)», y en un párrafo con tres citas del mismo año ese texto
 * aparece tres veces. Exigir que sea único dejaba sin traducir justo los
 * párrafos mejor citados.
 *
 * Así que se colocan EN ORDEN: la segunda cita se busca después de donde quedó
 * la primera, porque una traducción no reordena las citas de un párrafo. Y
 * cuando aún quedan varias posibles, se elige la que cae en el mismo sitio del
 * párrafo que ocupaba en el original —proporción, no carácter, que el texto
 * cambia de largo al traducirse—.
 *
 * Si una cita no aparece por ninguna parte, no se adivina: se lanza y quien
 * llama deja el párrafo como estaba.
 */
function enmascarar(textoNuevo, campos) {
  let texto = String(textoNuevo);
  let desde = 0;

  for (const campo of campos) {
    const expresion = comoExpresion(campo.texto);
    // Se busca en el texto igualado y se corta en el de verdad: miden lo mismo.
    const candidatos = [...igualar(texto).matchAll(expresion)].filter((encaje) => encaje.index >= desde);

    if (candidatos.length === 0) {
      const error = new NoProtegible(`el texto nuevo no trae «${campo.texto.slice(0, 40)}» tal cual`);
      error.cita = campo.texto;
      throw error;
    }

    const elegido =
      candidatos.length === 1
        ? candidatos[0]
        : candidatos.reduce((mejor, encaje) =>
            Math.abs(encaje.index / texto.length - (campo.relativo ?? 0)) <
            Math.abs(mejor.index / texto.length - (campo.relativo ?? 0))
              ? encaje
              : mejor,
          );

    texto = texto.slice(0, elegido.index) + campo.marca + texto.slice(elegido.index + elegido[0].length);
    desde = elegido.index + 1;
  }

  return texto;
}

// ── Devolver el campo a su sitio ───────────────────────────────────────────

/** Una corrida entera del XML terminado. No anidan, así que basta con esto. */
const CORRIDA = /<w:r(?:\s[^>]*)?>(?:(?!<\/w:r>)[\s\S])*<\/w:r>/g;

/**
 * El XML con cada marca cambiada por su campo.
 *
 * La marca viaja dentro de un `<w:t>`, pegada al texto que la rodea, así que la
 * corrida se parte en tres: lo de antes, el campo y lo de después, las dos
 * puntas con el mismo formato que tenían.
 *
 * Si al terminar falta algún campo —el motor pudo quitar la marca al comparar
 * palabra por palabra— se lanza: perder una cita en silencio es justo lo que no
 * puede pasar.
 */
function restaurar(xml, campos) {
  if (campos.length === 0) return xml;

  const porMarca = new Map(campos.map((campo) => [campo.marca, campo]));
  const puestos = new Set();

  const hecho = String(xml).replace(CORRIDA, (corrida) => {
    if (!llevaMarcas(corrida)) return corrida;

    const rPr = formatoDe(corrida);
    const abre = (corrida.match(/^<w:r(?:\s[^>]*)?>/) || ['<w:r>'])[0];
    const visible = textoVisible(corrida);
    const piezas = [];
    let pendiente = '';

    // La marca tiene que estar en un `<w:t>` y no en cualquier otro sitio. Si
    // acabó dentro de un `<w:delText>` —en edición, porque el modelo borró la
    // cita— cambiarla por el campo lo metería en un tachado. No se hace.
    if ([...corrida].filter(esMarca).length !== [...visible].filter(esMarca).length) {
      throw new NoProtegible('una cita quedó en un sitio donde no se puede devolver');
    }

    const cerrar = () => {
      if (pendiente === '') return;
      piezas.push(`${abre}${rPr}<w:t xml:space="preserve">${documento.escaparXml(pendiente)}</w:t></w:r>`);
      pendiente = '';
    };

    for (const caracter of visible) {
      const campo = porMarca.get(caracter);
      if (!campo) {
        pendiente += caracter;
        continue;
      }
      cerrar();
      piezas.push(campo.xml);
      puestos.add(campo.marca);
    }
    cerrar();

    return piezas.join('');
  });

  if (puestos.size !== campos.length) {
    throw new NoProtegible('se perdió una cita por el camino');
  }

  return hecho;
}

// ── Mirarlo antes de pedirlo ───────────────────────────────────────────────

/**
 * Una cita escrita a mano y pegada a una de Zotero: «(Acosta-Enriquez,» y
 * detrás el campo. Es el resto de una cita que se borró a medias, y un editor
 * —o el modelo— la arregla, con lo que el campo ya no vuelve tal cual.
 *
 * Paréntesis abierto, uno o varios apellidos con mayúscula y una coma, y la
 * marca del campo justo detrás. «(e.g., [cita])» no entra: no es un apellido.
 */
const CITA_ROTA = /\(\s*\p{Lu}[\p{L}'’-]+(?:\s+(?:&|y|and)?\s*\p{Lu}[\p{L}'’-]+)*,\s*([\u{E000}-\u{E03F}])/u;

/**
 * Las citas y enlaces de un párrafo, por su texto visible, y la cita rota si
 * la hay. Es lo que `preparar.motor` usa para rechazar una respuesta que
 * cambió una cita ANTES de escribir el Word, cuando aún se puede volver a
 * pedir.
 *
 * `citas` es null si el párrafo no se puede proteger: ese ya se quedará como
 * estaba por su cuenta, y no tiene sentido comprobar nada.
 */
function citasDe(xmlDelParrafo) {
  let protegido;
  try {
    protegido = proteger(xmlDelParrafo);
  } catch (error) {
    if (error instanceof NoProtegible) return { citas: null, rota: null };
    throw error;
  }
  if (protegido.campos.length === 0) return { citas: [], rota: null };

  const texto = documento.parrafosDe(protegido.xml)[0]?.texto ?? '';
  const encaje = CITA_ROTA.exec(texto);
  let rota = null;
  if (encaje) {
    const campo = protegido.campos.find((c) => c.marca === encaje[1]);
    rota = `${encaje[0].slice(0, -1)}${campo?.texto ?? ''}`.slice(0, 70);
  }

  return { citas: protegido.campos.map((campo) => campo.texto), rota };
}

/**
 * La primera cita que no está tal cual en el texto nuevo, o null. Con la misma
 * manga ancha que al escribir: guiones, apóstrofos, tildes y espacios.
 */
function citaQueFalta(texto, citas) {
  if (!citas || citas.length === 0) return null;
  const falsos = citas.map((cita, i) => ({ texto: cita, marca: String.fromCharCode(PRIMERA_MARCA + i), relativo: 0 }));
  try {
    enmascarar(texto, falsos);
    return null;
  } catch (error) {
    if (error instanceof NoProtegible) return error.cita ?? citas[0];
    throw error;
  }
}

module.exports = {
  citasDe,
  citaQueFalta,
  proteger,
  enmascarar,
  restaurar,
  llevaMarcas,
  NoProtegible,
  PRIMERA_MARCA,
};

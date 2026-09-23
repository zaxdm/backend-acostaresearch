'use strict';

/**
 * El índice, traducido con los títulos de los que sale.
 *
 * DE DÓNDE SALE ESTO
 * ------------------
 * De una entrega real (23-sep-2026): el cliente tradujo su tesis al inglés, y
 * le llegó todo en inglés —las tablas, los rótulos, el pie de página— menos el
 * índice, que seguía diciendo «CAPÍTULO I: PROBLEMA Y OBJETIVOS» debajo de un
 * título que ya decía «Table of Contents». Es lo primero que se ve al abrir el
 * documento.
 *
 * POR QUÉ NO SE MANDA AL MODELO COMO UN PÁRRAFO MÁS
 * -------------------------------------------------
 * Porque una línea de índice no es prosa: es un `<w:hyperlink>` al marcador del
 * título, un tabulador con puntitos y un campo `PAGEREF` que calcula el número
 * de página. `preparar.campos` saca los hipervínculos enteros y los reconoce
 * después por el texto que enseñan; traducido, ese texto ya no está, así que el
 * párrafo se quedaría intacto de todas formas. Y aunque se pudiera, sería pagar
 * por traducir dos veces lo mismo: cientos de líneas que son copia de los
 * títulos.
 *
 * CÓMO SE HACE ENTONCES
 * ---------------------
 * No se traduce: se copia. Cada línea del índice lleva el texto de un título
 * que sí se acaba de traducir, así que se busca ese título por su texto
 * original y se escribe el nuevo en su sitio, DENTRO del `<w:t>` que ya estaba.
 * El enlace, el tabulador, los puntitos y el campo del número de página no se
 * tocan: la línea sigue siendo la misma línea, con otras palabras.
 *
 * Así el índice dice lo mismo que los títulos aunque nadie actualice el campo,
 * que es justo lo que no pasa en la vista protegida de Word ni en un visor que
 * no es Word. Y cuando Word lo rehace, lo rehace a partir de esos mismos
 * títulos ya traducidos: sale igual.
 *
 * LO QUE NO ENCAJA SE QUEDA COMO ESTÁ
 * -----------------------------------
 * Una línea cuyo título no se llegó a traducir —porque el párrafo se quedó
 * intacto, o porque el cliente escribió el índice a mano y ya no coincide con
 * ningún título— se deja en su idioma. Inventar la traducción de una entrada
 * sería poner en el índice algo que no está en ningún capítulo.
 */

const documento = require('../projects/project.documento');

/**
 * Lo que separa el título de su número de página cuando no hay tabulador.
 *
 * Con tabulador —lo normal— la línea se parte sola. Pero un índice escrito a
 * mano trae los puntitos como texto: «Justificación...........5». Se quitan los
 * puntos y el número para poder comparar el título con el del capítulo, y no se
 * vuelven a escribir: solo se sustituye el trozo del título.
 */
const RELLENO = /[.·_…\s-]{2,}\s*(?:\d+|[ivxlcdm]+)?\s*$/i;

/**
 * La numeración delante del título: «1.1 Planteamiento del problema».
 *
 * Cuando el título está numerado con la numeración automática de Word, el
 * número NO es texto del párrafo —lo pone la lista—, pero en el índice sí lo
 * es. Por eso una entrada puede traer delante un número que el título no tiene:
 * se aparta para buscar, y se vuelve a escribir tal cual, porque la numeración
 * de un capítulo no se traduce.
 */
const NUMERACION = /^(\d+(?:\.\d+)*\.?)(\s+)(.+)$/;

/** El rótulo de una tabla o una figura delante de su título: «Tabla 1. Distribución». */
const ROTULO_CON_TITULO =
  /^((?:tabla|figura|gr[aá]fico|cuadro|ilustraci[oó]n)\s+\d+(?:\.\d+)*[a-z]?)\s*([.:])\s+(.+)$/i;

/** Hace falta al menos una letra: un «3» o una fila de puntos no es un título. */
const CON_LETRAS = /\p{L}/u;

/** La misma llave para el título y para su línea del índice: sin espacios y en minúscula. */
const llaveDe = (texto) => documento.esqueleto(String(texto)).toLowerCase();

/**
 * El título traducido tal como va a quedar en una sola línea.
 *
 * El modelo puede devolver el texto con saltos, y el humanizador puede pedir un
 * punto y aparte con `[APARTE]`. En el cuerpo eso sale como dos párrafos; en el
 * índice no cabe, así que la entrada lleva el título seguido.
 */
const enUnaLinea = (texto) =>
  String(texto)
    .replace(/\s*\[APARTE\]\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** ¿Es este párrafo una línea del índice? Por el nombre del estilo o por su identificador. */
function esDelIndice(parrafo, nombres) {
  const id = parrafo.estilo ?? '';
  return (
    documento.ESTILO_DE_INDICE.test(nombres.get(id) ?? '') || documento.ESTILO_DE_INDICE.test(id)
  );
}

/** Los trozos que separa cada tabulador, con dónde empieza cada uno en el párrafo. */
function segmentosDe(texto) {
  const segmentos = [];
  let desde = 0;
  for (const trozo of String(texto).split('\t')) {
    segmentos.push({ desde, texto: trozo });
    desde += trozo.length + 1;
  }
  return segmentos;
}

/** El título dentro del trozo: sin los espacios de los lados ni los puntitos con el número. */
function nucleoDe({ desde, texto }) {
  const sinCola = texto.replace(RELLENO, '');
  const limpio = sinCola.trim();
  if (limpio === '' || !CON_LETRAS.test(limpio)) return null;
  const a = desde + sinCola.indexOf(limpio);
  return { desde: a, hasta: a + limpio.length, texto: limpio };
}

/**
 * Lo que dice ahora el título del que salió esta entrada, o null.
 *
 * Los índices de tablas y de figuras juntan el rótulo con su título —«Tabla 1.
 * Distribución de la muestra»—, que en el documento son dos párrafos. Por eso,
 * cuando la entrada entera no encaja con ninguno, se prueba por las dos partes:
 * la que se haya traducido entra, y la que no se queda como estaba.
 */
function traduccionDe(texto, traducciones) {
  const entera = traducciones.get(llaveDe(texto));
  if (entera !== undefined) return entera;

  const numerado = NUMERACION.exec(texto);
  if (numerado) {
    const sinNumero = traducciones.get(llaveDe(numerado[3]));
    if (sinNumero !== undefined) return `${numerado[1]}${numerado[2]}${sinNumero}`;
  }

  const partido = ROTULO_CON_TITULO.exec(texto);
  if (!partido) return null;

  const rotulo = traducciones.get(llaveDe(partido[1]));
  const titulo = traducciones.get(llaveDe(partido[3]));
  if (rotulo === undefined && titulo === undefined) return null;

  return `${rotulo ?? partido[1]}${partido[2]} ${titulo ?? partido[3]}`;
}

/**
 * Las ediciones que escriben `nuevo` en el tramo `[desde, hasta)` del párrafo.
 *
 * El texto de un párrafo puede estar repartido en varias corridas —Word parte
 * por donde le parece—, así que el texto nuevo entra entero en la primera que
 * toca el tramo y las demás se quedan solo con lo que había fuera de él.
 */
function edicionesDeTramo(parrafo, desde, hasta, nuevo) {
  const tocadas = parrafo.piezas.filter(
    (pieza) =>
      pieza.tipo === 'texto' && pieza.desde < hasta && pieza.desde + pieza.texto.length > desde,
  );
  if (tocadas.length === 0) return [];

  const ediciones = [];
  let puesto = false;

  for (const pieza of tocadas) {
    const a = Math.max(0, desde - pieza.desde);
    const b = Math.min(pieza.texto.length, hasta - pieza.desde);
    const contenido = pieza.texto.slice(0, a) + (puesto ? '' : nuevo) + pieza.texto.slice(b);
    puesto = true;

    const { nodo } = pieza;
    // Sin `preserve`, Word se come el espacio del borde y el título sale pegado.
    if (/^\s|\s$/.test(contenido) && !/xml:space="preserve"/.test(nodo.etiqueta)) {
      ediciones.push({
        desde: nodo.etiquetaInicio,
        hasta: nodo.etiquetaInicio + nodo.etiqueta.length,
        poner: '<w:t xml:space="preserve">',
      });
    }
    ediciones.push({
      desde: nodo.contenidoInicio,
      hasta: nodo.contenidoInicio + nodo.crudo.length,
      poner: documento.escaparXml(contenido),
    });
  }

  return ediciones;
}

/**
 * Las ediciones que ponen el índice en el idioma de los títulos ya traducidos.
 *
 * `parrafos` son los de `documento.parrafosDe` de esa parte del zip, `hechos`
 * los párrafos que SÍ se escribieron —`{ original, texto }`— y `saltar` los
 * números de los que ya tienen una edición propia, para no escribir dos veces
 * en el mismo sitio.
 *
 * Devuelve también cuántas líneas de índice se vieron y cuántas se quedaron sin
 * pareja, que es lo que permite decirlo en vez de suponerlo.
 */
function edicionesDelIndice({ parrafos, estilos, hechos, saltar = new Set() }) {
  const traducciones = new Map();
  for (const { original, texto } of hechos) {
    const llave = llaveDe(original);
    // El primero manda: dos títulos iguales con traducciones distintas no se
    // pueden distinguir desde el índice, y elegir la segunda no es más cierto.
    if (!traducciones.has(llave)) traducciones.set(llave, enUnaLinea(texto));
  }

  const nombres = documento.nombresDeEstilos(estilos ?? '');
  const ediciones = [];
  let entradas = 0;
  let sinPareja = 0;

  for (const parrafo of parrafos) {
    if (saltar.has(parrafo.id) || !esDelIndice(parrafo, nombres)) continue;

    let tocada = false;
    let esEntrada = false;

    for (const segmento of segmentosDe(parrafo.texto)) {
      const nucleo = nucleoDe(segmento);
      if (!nucleo) continue;
      esEntrada = true;

      const nuevo = traduccionDe(nucleo.texto, traducciones);
      if (nuevo === null || nuevo === '' || nuevo === nucleo.texto) continue;

      const suyas = edicionesDeTramo(parrafo, nucleo.desde, nucleo.hasta, nuevo);
      if (suyas.length === 0) continue;
      ediciones.push(...suyas);
      tocada = true;
    }

    if (!esEntrada) continue;
    entradas += 1;
    if (!tocada) sinPareja += 1;
  }

  return { ediciones, entradas, sinPareja };
}

module.exports = { edicionesDelIndice, llaveDe };

'use strict';

const crypto = require('node:crypto');

/**
 * Marca de agua invisible para el contenido que sí sale del servidor.
 *
 * QUÉ HACE Y QUÉ NO
 * -----------------
 * No impide copiar nada. Lo que hace es que una copia filtrada se pueda
 * atribuir: pegas el texto que apareció en un grupo de WhatsApp y sabes de qué
 * licencia salió. Convierte «prohibido compartir» en una amenaza que puedes
 * cumplir, y esa es toda la diferencia entre una advertencia y una disuasión.
 *
 * CÓMO
 * ----
 * El identificador de la licencia se escribe en binario usando dos caracteres
 * de ancho cero al principio de determinados párrafos: uno para el 0 y otro
 * para el 1. Son invisibles al leer, no cambian el significado y sobreviven a
 * un copiar y pegar normal.
 *
 * Van al PRINCIPIO DE PÁRRAFO, nunca dentro de una palabra: metidos en medio
 * de una palabra podrían alterar cómo el modelo la lee, y el método tiene que
 * seguir funcionando igual de bien marcado que sin marcar.
 *
 * Quien sepa que esto existe puede limpiarlo. Como todo: no es un candado, es
 * una firma.
 */

const CERO = '​'; // espacio de ancho cero
const UNO = '‌'; // no-juntador de ancho cero

/** Bits que se escriben. 32 bits identifican de sobra un catálogo de licencias. */
const BITS = 32;

/** Huella estable de una licencia, como número de 32 bits. */
function huella(licenseId) {
  const hash = crypto.createHash('sha256').update(licenseId).digest();
  return hash.readUInt32BE(0);
}

function aBits(numero) {
  return numero.toString(2).padStart(BITS, '0').split('').map(Number);
}

/**
 * ¿Sirve esta línea para llevar una marca?
 *
 * Se descartan las que empiezan por un carácter con significado en Markdown
 * —encabezados, tablas, código, citas, reglas— porque ahí un carácter extra
 * podría cambiar cómo se interpreta la línea, y el método tiene que funcionar
 * igual de bien marcado que sin marcar.
 *
 * Lo que queda son líneas con cuerpo: prosa y contenido de listas, que es de lo
 * que están hechas estas skills. Exigir además que empezaran por letra dejaba
 * fuera casi todo, porque el método usa listas por todas partes.
 */
function marcable(linea) {
  const limpia = linea.trim();
  return limpia.length > 25 && !/^[#|`\->*═─~=+[\]]/.test(limpia);
}

/** Inserta la marca DESPUÉS de la sangría, para no alterar la estructura. */
function insertar(linea, caracter) {
  const sangria = linea.length - linea.trimStart().length;
  return linea.slice(0, sangria) + caracter + linea.slice(sangria);
}

/**
 * Escribe la marca en el texto.
 *
 * Va por LÍNEAS y no por párrafos: los tramos del método usan listas y saltos
 * simples, así que las líneas en blanco escasean y repartir por párrafos dejaba
 * fragmentos enteros sin marcar.
 *
 * Si no hay líneas suficientes para los 32 bits se marca lo que quepa: una
 * huella parcial sigue estrechando el círculo de sospechosos.
 */
function marcar(texto, licenseId) {
  const bits = aBits(huella(licenseId));
  const lineas = texto.split('\n');

  const candidatas = [];
  for (let i = 0; i < lineas.length; i += 1) {
    if (marcable(lineas[i])) candidatas.push(i);
  }

  if (candidatas.length < 8) return texto;

  // Se reparten a lo largo de todo el texto, para que cualquier trozo que se
  // filtre lleve unas cuantas.
  const paso = Math.max(1, Math.floor(candidatas.length / bits.length));
  let escritos = 0;

  for (let i = 0; i < bits.length; i += 1) {
    const indice = candidatas[i * paso];
    if (indice === undefined) break;
    lineas[indice] = insertar(lineas[indice], bits[i] === 1 ? UNO : CERO);
    escritos += 1;
  }

  return escritos >= 8 ? lineas.join('\n') : texto;
}

/**
 * Lee la marca de un texto filtrado y devuelve la huella encontrada.
 *
 * Devuelve null si no hay marcas: puede que la copia venga de otro sitio, o que
 * alguien las haya limpiado.
 */
function leer(texto) {
  const marcas = [];
  for (const caracter of texto) {
    if (caracter === CERO) marcas.push(0);
    else if (caracter === UNO) marcas.push(1);
  }

  if (marcas.length < 8) return null;

  return {
    bits: marcas,
    // Con menos de 32 bits la huella es parcial, pero sigue sirviendo para
    // descartar licencias.
    completa: marcas.length >= BITS,
    valor: marcas.length >= BITS ? parseInt(marcas.slice(0, BITS).join(''), 2) : null,
  };
}

/**
 * ¿De cuál de estas licencias salió el texto?
 *
 * Lo normal no es que alguien filtre el documento entero: filtra un trozo. Y
 * en un trozo los bits no empiezan por el principio, así que hay que probar
 * TODOS los desplazamientos posibles hasta encontrar dónde encajan.
 *
 * Con una marca parcial pueden salir varias candidatas. Aun así sirve: reduce
 * la lista, y cruzándola con quién pidió ese capítulo suele quedar una sola.
 */
function identificar(texto, licenseIds) {
  const marca = leer(texto);
  if (!marca) return { encontrada: false, candidatas: [] };

  const encaja = (bits, esperados) => {
    // Una marca completa se compara desde el principio y punto.
    if (bits.length >= esperados.length) {
      return esperados.every((bit, i) => bits[i] === bit);
    }
    // Un fragmento puede empezar en cualquier bit de la secuencia.
    for (let desfase = 0; desfase <= esperados.length - bits.length; desfase += 1) {
      if (bits.every((bit, i) => bit === esperados[desfase + i])) return true;
    }
    return false;
  };

  const candidatas = licenseIds.filter((id) => encaja(marca.bits, aBits(huella(id))));

  return { encontrada: true, completa: marca.completa, bits: marca.bits.length, candidatas };
}

/** Quita las marcas. Sirve para comparar textos o para depurar. */
function limpiar(texto) {
  return texto.split(CERO).join('').split(UNO).join('');
}

module.exports = { marcar, leer, identificar, limpiar, huella };

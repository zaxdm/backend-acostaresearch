'use strict';

/**
 * Tablas y figuras numeradas en el orden en que salen en el Word.
 *
 * POR QUÉ HACE FALTA
 * ------------------
 * La skill del Capítulo I guarda la matriz de consistencia y la de
 * operacionalización como anexos al final de su texto, con las Tablas 1 a 4.
 * El capítulo siguiente sigue contando desde ahí (Tabla 5, 6…). Pero los anexos
 * se imprimen al final del Word, así que la tesis salía con las Tablas 5, 6, 7,
 * 8 en el cuerpo y las 1, 2, 3, 4 en los anexos, y el índice de tablas igual
 * (E2E de tesis del 8-nov-2026). El servidor imprimía el número que escribía
 * Claude.
 *
 * QUÉ HACE
 * --------
 * Recibe los textos en el orden final (cuerpo y después anexos) y vuelve a
 * numerar los rótulos «**Tabla N**» y «**Figura N**» 1, 2, 3… según aparecen.
 * Las menciones del texto («la Tabla 5 muestra…», «Tablas 5 y 6», la marca
 * «[Insertar aquí la Figura 2: …]») pasan al número nuevo de esa misma tabla.
 *
 * Lo que NO toca:
 * - Si los rótulos ya van 1, 2, 3… en orden, nada.
 * - Si algún rótulo es de los que numeran por capítulo («Tabla 1.1», «Tabla
 *   2a»), nada de ese tipo: esa numeración la eligió el tesista.
 * - Una mención a un número que no es de ningún rótulo del documento (la tabla
 *   de un autor citado) se queda como está.
 */

/** «**Tabla 5**», sola en su línea: el rótulo. */
const ROTULO_RE = /^(\s*[*_]*\s*)(Tabla|Figura)(\s+)(\d+)(\s*[*_]*\s*)$/i;
/** «Tabla 1.1», «Figura 2a»: numeración por capítulo, que no se toca. */
const ROTULO_PROPIO_RE = /^\s*[*_]*\s*(Tabla|Figura)\s+\d+(?:(?:\.\d+)+|[A-Za-z])\s*[*_]*\s*$/i;
/** «Tabla 5», «tablas 5 y 6», «Figuras 2, 3 y 4», «Tablas 5 a 8» dentro del texto. */
const MENCION_RE = /\b(Tablas?|Figuras?)(\s+)(\d+)((?:\s*(?:,|y|e|a|al|–|-)\s*\d+)*)(?!\d|\.\d)/gi;

const tipoDe = (palabra) => (/^tabla/i.test(palabra) ? 'tabla' : 'figura');

/** Recorre las líneas fuera de los bloques de código. */
function porLineas(texto, cada) {
  let enCodigo = false;
  return String(texto ?? '')
    .split('\n')
    .map((linea) => {
      if (/^\s*```/.test(linea)) {
        enCodigo = !enCodigo;
        return linea;
      }
      return enCodigo ? linea : cada(linea);
    })
    .join('\n');
}

/**
 * Los textos con tablas y figuras numeradas por orden de aparición.
 *
 * @param {string[]} textos  Los textos de las secciones, en el orden del Word.
 * @returns {string[]} Los mismos textos; si no hace falta cambiar nada, iguales.
 */
function renumerarRotulos(textos) {
  // 1. Los rótulos, en orden, y qué tipos se pueden tocar.
  const rotulos = { tabla: [], figura: [] };
  const propios = new Set();
  textos.forEach((texto, seccion) => {
    porLineas(texto, (linea) => {
      const propio = linea.match(ROTULO_PROPIO_RE);
      if (propio) propios.add(tipoDe(propio[1]));
      const rotulo = linea.match(ROTULO_RE);
      if (rotulo) rotulos[tipoDe(rotulo[2])].push({ seccion, viejo: Number(rotulo[4]) });
      return linea;
    });
  });

  // 2. El número nuevo de cada uno, por tipo. Las menciones buscan primero el
  // rótulo de su misma sección y, si no, el primero del documento con ese número.
  const mapas = {};
  for (const tipo of ['tabla', 'figura']) {
    const lista = rotulos[tipo];
    if (propios.has(tipo) || lista.every((r, i) => r.viejo === i + 1)) continue;
    const porSeccion = new Map();
    const general = new Map();
    lista.forEach((r, i) => {
      if (!porSeccion.has(r.seccion)) porSeccion.set(r.seccion, new Map());
      const suyo = porSeccion.get(r.seccion);
      if (!suyo.has(r.viejo)) suyo.set(r.viejo, i + 1);
      if (!general.has(r.viejo)) general.set(r.viejo, i + 1);
    });
    mapas[tipo] = { porSeccion, general };
  }
  if (Object.keys(mapas).length === 0) return textos;

  // 3. Se reescriben: los rótulos por orden, las menciones por el mapa.
  const contador = { tabla: 0, figura: 0 };
  return textos.map((texto, seccion) =>
    porLineas(texto, (linea) => {
      const rotulo = linea.match(ROTULO_RE);
      if (rotulo) {
        const tipo = tipoDe(rotulo[2]);
        contador[tipo] += 1;
        if (!mapas[tipo]) return linea;
        return `${rotulo[1]}${rotulo[2]}${rotulo[3]}${contador[tipo]}${rotulo[5]}`;
      }
      return linea.replace(MENCION_RE, (entera, palabra, espacio, primero, resto) => {
        const mapa = mapas[tipoDe(palabra)];
        if (!mapa) return entera;
        const nuevo = (n) => mapa.porSeccion.get(seccion)?.get(Number(n)) ?? mapa.general.get(Number(n)) ?? n;
        return `${palabra}${espacio}${nuevo(primero)}${resto.replace(/\d+/g, nuevo)}`;
      });
    }),
  );
}

module.exports = { renumerarRotulos };

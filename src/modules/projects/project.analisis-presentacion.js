'use strict';
const bloques = require('./project.bloques');
/**
 * Un número con sus puntos de millar.
 *
 * A mano y no con `toLocaleString`: el formato tiene que ser el mismo en el
 * servidor y en las pruebas, y eso depende de qué datos de idioma traiga
 * compilado el Node que haya en cada sitio.
 */
function conMiles(numero) {
  return String(numero).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

const AVISO_DE_EVIDENCIA =
  'ESTE ÍNDICE DICE DÓNDE ESTÁ CADA RESULTADO, NO CUÁL ES: no contiene ni un solo número. ' +
  'Para escribir una cifra en el capítulo, pide antes su bloque y léelo. Después guárdala ' +
  'con "guardar_analisis". El repaso de evidencia marca los números del texto que no salgan ' +
  'ni de las cifras guardadas ni de esta consola.';
/** Las líneas de un texto, sin fingir que un archivo vacío tiene una. */
function cuantasLineas(texto) {
  return texto ? texto.split('\n').length : 0;
}

/** «alfa  54-62» o «descriptivos  35-45 y 63-65», alineado para poder leerlo. */
function lineaDeIndice(clave, rangos, ancho) {
  const donde = rangos.map((r) => `${r.desde}-${r.hasta}`).join(' y ');
  return `  ${clave.padEnd(ancho)}  ${donde}`;
}

/**
 * El panorama del análisis: qué hay y dónde, sin el contenido.
 *
 * NO lleva el script —son novecientos tokens de órdenes, sin una sola cifra— ni
 * intenta extraer los números de la consola. Lo primero es localización y se
 * apoya en marcadores literales; lo segundo sería interpretar, y ahí es donde se
 * cuela un número que nadie calculó.
 */
function resumenDeAnalisis({ capitulo, script, salida, cifras, fecha }) {
  const hallados = bloques.detectar(salida);
  const partes = [];

  const cuando = fecha ? ` · ${fecha.toISOString().slice(0, 10)}` : '';
  partes.push(`ANÁLISIS GUARDADO · ${capitulo}${cuando}`);

  partes.push(
    [
      script
        ? `Script: ${conMiles(script.length)} caracteres, ${cuantasLineas(script)} líneas. ` +
          'No va aquí: pídelo con ver_analisis(bloque: "script").'
        : 'Script: no se guardó.',
      salida
        ? `Consola: ${conMiles(salida.length)} caracteres, ${cuantasLineas(salida)} líneas. ` +
          'NO va entera.'
        : 'Consola: no se guardó.',
    ].join('\n'),
  );

  if (hallados.length === 0) {
    partes.push(
      'No se ha reconocido ningún resultado estadístico en esta consola. Puede que el análisis ' +
        'venga de un RStudio propio. Pídela entera con ' +
        'ver_analisis(bloque: "todo") o por tramos con desde y hasta.',
    );
  } else {
    // En el orden en que salieron, que es el orden en que trabajó el tesista.
    const porClave = new Map();
    for (const b of hallados) {
      if (!porClave.has(b.clave)) porClave.set(b.clave, []);
      porClave.get(b.clave).push(b);
    }

    const ancho = Math.max(...[...porClave.keys()].map((c) => c.length));
    const lineas = [...porClave.entries()].map(([clave, rangos]) =>
      lineaDeIndice(clave, rangos, ancho),
    );

    partes.push(
      `RESULTADOS EN LA CONSOLA (${hallados.length} bloques)\n${lineas.join('\n')}`,
    );

    const sueltas = bloques.lineasSueltas(salida);
    if (sueltas > 0) {
      partes.push(
        `Hay ${sueltas} líneas de consola fuera de esos bloques: la carga del archivo, los ` +
          'head(), los avisos de R, las líneas en blanco entre pruebas y lo que no sabemos ' +
          'nombrar. Se piden con desde y hasta.',
      );
    }
  }

  partes.push(
    cifras.length > 0
      ? `Cifras ya guardadas (${cifras.length}):\n${cifras.map((c) => `  - ${c}`).join('\n')}`
      : 'Cifras guardadas: ninguna todavía.',
  );

  partes.push(AVISO_DE_EVIDENCIA);
  partes.push(`Bloques que puedes pedir: ${bloques.claves().join(' · ')} · script · todo`);

  return partes.join('\n\n');
}

/** Un bloque del catálogo, con todas sus apariciones. */
function bloqueDeAnalisis(salida, clave) {
  const definicion = bloques.definicionDe(clave);

  if (!definicion) {
    return (
      `"${clave}" no es un bloque de análisis. Los que existen son: ` +
      `${bloques.claves().join(', ')}, más "script" y "todo".`
    );
  }

  const halladas = bloques.apariciones(salida, clave);

  if (halladas.length === 0) {
    const otros = bloques.detectar(salida);
    return (
      `En esta consola no aparece ningún bloque de ${definicion.nombre.toLowerCase()}. ` +
      'No te doy otro parecido: sería darte una prueba por otra.\n\n' +
      (otros.length > 0
        ? `Lo que sí hay: ${[...new Set(otros.map((b) => b.clave))].join(', ')}.`
        : 'No se ha reconocido ningún resultado en esta consola.')
    );
  }

  const cuerpo =
    halladas.length === 1
      ? `${definicion.nombre} · líneas ${halladas[0].desde}-${halladas[0].hasta} de la consola\n\n${halladas[0].texto}`
      : `${definicion.nombre} · ${halladas.length} apariciones\n\n` +
        halladas
          .map((b) => `── líneas ${b.desde}-${b.hasta} ──\n${b.texto}`)
          .join('\n\n');

  return (
    `${cuerpo}\n\n` +
    'Las cifras de aquí que vayan al capítulo, guárdalas con "guardar_analisis".'
  );
}

/** Un tramo de consola pedido a mano, con su aviso si hubo que recortarlo. */
function tramoDeAnalisis(salida, desde, hasta) {
  const t = bloques.tramo(salida, desde, hasta);

  if (t.error === 'al-reves') {
    return `"desde" (${desde}) tiene que ser menor o igual que "hasta" (${hasta}). La consola tiene ${t.total} líneas.`;
  }
  if (t.error === 'fuera-de-rango' || t.error === 'no-entero') {
    return `Ese tramo no existe. La consola tiene ${t.total} líneas, así que el rango válido va de 1 a ${t.total}.`;
  }

  const cabecera = `CONSOLA · líneas ${t.desde}-${t.hasta} de ${t.total}`;
  const aviso = t.recortado
    ? `\n\nPediste ${t.pedidas} líneas. Para que la respuesta siga siendo manejable van las ` +
      `primeras ${bloques.MAXIMO_LINEAS}: líneas ${t.desde}-${t.hasta}. Sigue con desde: ${t.siguiente}.`
    : '';

  return `${cabecera}\n\n${t.texto}${aviso}`;
}


module.exports = { cuantasLineas, resumenDeAnalisis, bloqueDeAnalisis, tramoDeAnalisis };

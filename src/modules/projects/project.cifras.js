'use strict';

/**
 * Que las cifras del texto salgan del cálculo.
 *
 * EL PROBLEMA
 * -----------
 * Un modelo de lenguaje que redacta un capítulo de resultados escribe números
 * con la misma naturalidad con la que escribe adjetivos. No miente a propósito:
 * es que un texto de resultados tiene forma de llevar un p = 0,03 ahí, y lo
 * pone. El tesista lo lee, le cuadra, y lo entrega. Y ese número no lo devolvió
 * ninguna prueba.
 *
 * El brief pedía comprobar que los números del texto cuadren con los de las
 * tablas (§4.8) y daba por hecho que hacía falta ejecutar R para eso. No hace
 * falta: basta con que el tesista pegue lo que le devolvió SU RStudio, y
 * comparar contra eso. El cálculo lo sigue haciendo él en su máquina; lo que
 * aporta el servidor es que nadie pueda escribir un número que no esté ahí.
 *
 * QUÉ CUENTA COMO CIFRA
 * ---------------------
 * Solo lo que tiene forma de resultado estadístico. Un texto académico está
 * lleno de números que no lo son —el año de una cita, «capítulo 3», «los 120
 * estudiantes»— y marcarlos sería la manera más rápida de que este aviso se
 * ignore entero.
 */

/**
 * Un decimal, o un porcentaje, o un número precedido de una etiqueta
 * estadística. Se captura el número completo para poder compararlo.
 */
// El porcentaje va PRIMERO en la alternativa. Al revés, «33,3%» casa con la
// primera rama sin llegar al signo y se guarda como «33,3»: la misma cifra
// escrita de dos maneras dejaría de reconocerse.
//
// La notación científica va antes todavía, por lo mismo: R escribe
// «p-value = 2.996e-05», y sin su rama se leería «2.996» y el exponente se
// perdería.
//
// La última rama es el decimal SIN cero delante, «.51». Es como APA 7 manda
// escribir r, p y alfa, que no pueden pasar de 1, y es como los escribe Claude.
// Sin ella «r = .73» no se detectaba como cifra: un número inventado en el
// formato correcto pasaba el repaso sin marcarse. Solo con punto: «,51» no lo
// escribe nadie, y admitirlo partiría «0,29,0,67» por donde no es.
//
// El corchete entra entre lo que puede ir delante por los intervalos de
// confianza: «IC 95% [.296, .677]».
const CIFRA =
  /(?:^|[\s(\[=<>≤≥,;])(-?\d+(?:[.,]\d+)?[eE][-+]?\d+|-?\d+(?:[.,]\d+)?\s*%|-?\d+[.,]\d+|-?\.\d+)/g;

/** Años: 1900-2099. Se descartan siempre; son citas, no resultados. */
const ANIO = /^(19|20)\d{2}$/;

/**
 * Un número suelto dentro de un texto, con su signo.
 *
 * Con el decimal sin cero delante —«alfa = .886», que sin espacios se leía
 * 886— y con exponente —«2.996e-05», que se leía -5 porque el último número de
 * la cadena era el exponente—.
 */
const NUMERO = /-?(?:\d+(?:[.,]\d+)?|\.\d+)(?:[eE][-+]?\d+)?/g;

/**
 * El número de una cifra, venga sola o con su etiqueta delante.
 *
 * Lo que guarda el asistente es «alfa de Cronbach = 0.87», no «0.87». Intentar
 * convertir esa cadena entera a número da NaN, y entonces la lista de cifras
 * guardadas queda vacía sin que nadie se entere: el control seguiría corriendo
 * y no compararía nada. Se toma el ÚLTIMO número de la cadena, que en
 * «etiqueta = valor» es siempre el valor —en «R2 = 0.4231», el 2 del nombre no
 * es el resultado—.
 */
function normalizarNumero(bruto) {
  const encontrados = String(bruto).replace(/\s/g, '').match(NUMERO);
  if (!encontrados || encontrados.length === 0) return null;

  const n = Number.parseFloat(encontrados[encontrados.length - 1].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Las cifras con pinta de resultado que hay en un texto.
 *
 * Devuelve el número y el trozo de frase donde apareció, para poder enseñárselo
 * al tesista: «0,42» solo no le dice dónde mirar.
 */
function cifrasDe(texto) {
  const encontradas = [];

  for (const coincidencia of texto.matchAll(CIFRA)) {
    const bruto = coincidencia[1];
    const esPorcentaje = bruto.includes('%');
    // Con exponente también es un resultado: R escribe «3e-05» sin decimales.
    const sinDecimales = !/[.,]\d|[eE][-+]?\d/.test(bruto);

    // Un entero suelto no es un resultado; un entero con % sí.
    if (sinDecimales && !esPorcentaje) continue;

    const valor = normalizarNumero(bruto);
    if (valor === null) continue;
    // El año solo se descarta si es un entero. Quitándole el punto a un decimal,
    // «M = 20.13» —una media de edad corriente— se convertía en 2013 y se tiraba
    // como si fuera la fecha de una cita. Y «r = .2013», igual.
    if (!esPorcentaje && sinDecimales && ANIO.test(bruto)) continue;

    const desde = Math.max(0, coincidencia.index - 60);
    encontradas.push({
      bruto: bruto.trim(),
      valor,
      esPorcentaje,
      contexto: texto.slice(desde, coincidencia.index + bruto.length + 40).replace(/\s+/g, ' ').trim(),
    });
  }

  return encontradas;
}

/**
 * Los números que protege cada cifra guardada: TODOS los que tenga.
 *
 * Antes solo se tomaba el último de cada línea, pensando en «R2 = 0.4231». Pero
 * un asistente guarda también «Pearson: r = .511, p < .001, r2 = .2613», y de
 * esa línea solo quedaba protegido el .2613: al escribir «r = .51» en el
 * capítulo, el repaso lo marcaba como inventado. Y el asistente creía haberlo
 * guardado todo, que es lo peor de los dos errores.
 *
 * Se leen con las mismas reglas que las cifras del texto, así que el 2 de «R2»
 * sigue sin contar: no lleva decimales. El último número se añade además, por
 * si la línea es un entero con etiqueta que el texto no habría detectado.
 */
function valoresGuardados(resultados = []) {
  const valores = [];

  for (const linea of resultados) {
    for (const cifra of cifrasDe(String(linea))) valores.push(cifra.valor);
    const ultimo = normalizarNumero(linea);
    if (ultimo !== null) valores.push(ultimo);
  }

  return valores;
}

/**
 * ¿Está esta cifra entre los resultados guardados?
 *
 * Se compara con una tolerancia mínima porque el tesista redondea: un R² de
 * 0,4231 se escribe «0,42», y marcarlo sería marcar la forma correcta de
 * citarlo. La tolerancia es relativa para que valga igual con 0,03 que con
 * 1.250,5.
 */
function coincide(valor, guardados) {
  return guardados.some((g) => {
    const margen = Math.max(Math.abs(g) * 0.01, 0.005);
    return Math.abs(g - valor) <= margen;
  });
}

/**
 * Las cifras del texto que no salen de ningún resultado guardado.
 *
 * `resultados` son los valores que el tesista pegó de su análisis. Si no hay
 * ninguno guardado se devuelve lista vacía y no se marca nada: sin nada contra
 * qué comparar, marcarlo todo sería el mismo error que comparar a un comprador
 * nuevo con un histórico que no tiene.
 */
function sinRespaldo(texto, resultados = []) {
  const guardados = valoresGuardados(resultados);
  if (guardados.length === 0) return [];

  const vistas = new Set();
  const sueltas = [];

  for (const cifra of cifrasDe(texto)) {
    if (coincide(cifra.valor, guardados)) continue;
    if (vistas.has(cifra.bruto)) continue;
    vistas.add(cifra.bruto);
    sueltas.push(cifra);
  }

  return sueltas;
}

module.exports = { cifrasDe, sinRespaldo, coincide, normalizarNumero, valoresGuardados, CIFRA };

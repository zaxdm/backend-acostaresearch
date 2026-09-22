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
 * Los umbrales de significación, que son convención y no resultado.
 *
 * «p ≥ .05 indica que los datos no se apartan de la normal» no reporta nada:
 * enuncia la regla con la que se lee la prueba. Marcarlo obliga al tesista a
 * «anotar» un número que ninguna prueba devolvió, y es la clase de aviso falso
 * que hace que se ignoren también los verdaderos.
 *
 * Solo cuenta como umbral si va detrás de una DESIGUALDAD —«p < .05»,
 * «p ≥ .05»—, que es como se escribe la convención. Con el igual —«p = .05»—
 * se está reportando un valor concreto, y ese sí tiene que salir del análisis.
 */
const UMBRALES = [0.05, 0.01, 0.001, 0.1];

// «p <», «α ≤», «alfa >»: la etiqueta y el signo que preceden a un umbral. El
// «=» opcional del final es para quien escribe «p >= .05» en vez de «p ≥ .05»;
// sin él, la mitad de los capítulos seguía viendo el aviso falso. Exige un
// signo de desigualdad antes, así que «p = .05» no entra por aquí.
const ANTES_DE_UMBRAL = /(?:^|[\s(\[])(?:p|α|alfa)\s*[<>≤≥]=?\s*$/i;

/** El nivel de un intervalo de confianza: «IC 95%», «CI 99%». Tampoco es un resultado. */
const NIVELES_DE_CONFIANZA = [90, 95, 99];
const ANTES_DE_NIVEL = /(?:IC|CI|intervalo de confianza|nivel de confianza)\s*(?:del?\s*)?$/i;

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

    // Dónde empieza el número de verdad: la coincidencia puede llevar delante
    // el separador que lo ancla —un espacio, un paréntesis, un «=»—, y para
    // mirar qué lo precede hay que descontarlo.
    const inicio = coincidencia.index + (coincidencia[0].length - coincidencia[1].length);
    const precede = texto.slice(Math.max(0, inicio - 40), inicio);

    const desde = Math.max(0, coincidencia.index - 60);
    encontradas.push({
      bruto: bruto.trim(),
      valor,
      esPorcentaje,
      esUmbral:
        (!esPorcentaje && UMBRALES.includes(Math.abs(valor)) && ANTES_DE_UMBRAL.test(precede)) ||
        (esPorcentaje && NIVELES_DE_CONFIANZA.includes(Math.abs(valor)) && ANTES_DE_NIVEL.test(precede)),
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
 * TODOS los números de la consola de R, enteros incluidos.
 *
 * `cifrasDe` descarta los enteros sueltos porque en un texto académico casi
 * nunca son resultados. En la consola sí lo son: `descriptivos()` imprime el
 * máximo como «5», y el capítulo lo escribe «5.00». Descartarlo aquí dejaba esa
 * columna sin respaldo.
 */
function numerosDe(salida) {
  if (!salida) return [];
  const encontrados = String(salida).match(NUMERO) ?? [];
  const valores = [];
  for (const bruto of encontrados) {
    const n = Number.parseFloat(bruto.replace(',', '.'));
    if (Number.isFinite(n)) valores.push(n);
  }
  return valores;
}

/** Cuántos decimales se escribieron: «5.00» son dos, «.511» son tres. */
function decimalesDe(bruto) {
  const sinSigno = String(bruto).replace('%', '').trim();
  const punto = sinSigno.search(/[.,]/);
  return punto === -1 ? 0 : sinSigno.length - punto - 1;
}

/**
 * ¿Sale esta cifra de la consola, escrita con los decimales del capítulo?
 *
 * La comparación es por REDONDEO a lo que se escribió, no por la banda del 1 %
 * que se usa con las cifras guardadas. La consola trae decenas de números, y
 * una banda relativa acabaría dando por bueno casi cualquier cosa: con el
 * redondeo, «r = .51» lo respalda el 0.5112 de la consola y «p = .041» no lo
 * respalda nada, que es justo la distinción que hay que conservar.
 */
function saleDeLaConsola(valor, bruto, numeros) {
  if (numeros.length === 0) return false;
  const decimales = Math.min(decimalesDe(bruto), 10);
  const escrito = valor.toFixed(decimales);
  return numeros.some((n) => n.toFixed(decimales) === escrito);
}

/**
 * Las cifras del texto que no salen de ningún resultado guardado.
 *
 * `resultados` son los valores que el tesista pegó de su análisis. Si no hay
 * ninguno guardado se devuelve lista vacía y no se marca nada: sin nada contra
 * qué comparar, marcarlo todo sería el mismo error que comparar a un comprador
 * nuevo con un histórico que no tiene.
 */
function sinRespaldo(texto, resultados = [], salida = '') {
  const guardados = valoresGuardados(resultados);
  if (guardados.length === 0) return [];

  // La consola de R es la prueba de origen: un número que R imprimió no se lo
  // inventó nadie, esté o no en la lista curada de `guardar_analisis`. Antes
  // solo contaba esa lista, y salían marcados los mínimos y los máximos de la
  // tabla de descriptivos y los grados de libertad de las t, que estaban en la
  // consola desde el principio.
  const consola = numerosDe(salida);

  const vistas = new Set();
  const sueltas = [];

  for (const cifra of cifrasDe(texto)) {
    if (cifra.esUmbral) continue;
    if (coincide(cifra.valor, guardados)) continue;
    if (saleDeLaConsola(cifra.valor, cifra.bruto, consola)) continue;
    if (vistas.has(cifra.bruto)) continue;
    vistas.add(cifra.bruto);
    sueltas.push(cifra);
  }

  return sueltas;
}

module.exports = {
  cifrasDe,
  sinRespaldo,
  coincide,
  normalizarNumero,
  valoresGuardados,
  numerosDe,
  saleDeLaConsola,
  CIFRA,
};

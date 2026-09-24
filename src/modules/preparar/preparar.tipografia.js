'use strict';

/**
 * Los símbolos que sobran o están mal puestos, arreglados sin preguntar al
 * modelo.
 *
 * POR QUÉ CON CÓDIGO
 * ------------------
 * El 24-sep-2026 se comparó una edición nuestra con cinco manuscritos editados
 * por Rubriq. Un tercio de sus cambios (278 de 844) no son de gramática: son
 * espacios dobles, espacios alrededor de la raya, un guion donde va una raya
 * de rango, un «´» haciendo de apóstrofo. Nuestra edición no tocó ninguno, y
 * además dejó pasar «## Annex 1» y «Table 1.1** *», restos de Markdown que el
 * tesista había pegado.
 *
 * Son reglas fijas y un modelo las aplica a medias —se le escapa un espacio
 * doble, no ve un U+2011—, así que se hacen aquí, igual en cada párrafo. Van al
 * texto que devolvió el modelo, antes de marcarlo: salen en el control de
 * cambios como cualquier otra corrección y el autor puede rechazarlas.
 *
 * QUÉ NO SE TOCA
 * --------------
 * Lo que puede tener sentido aunque lo parezca: un asterisco de significación
 * («.45**»), un comodín de búsqueda («trend* OR student*»), un identificador
 * con guiones («978-3-16», un DOI, una URL). Solo se arregla lo que no puede
 * estar bien en ningún caso.
 */

/** Un trozo que no se toca: URL, DOI, correo. */
const INTOCABLE = /(?:https?:\/\/|www\.|doi\.org|\b10\.\d{4,}\/)\S*|\S+@\S+\.\S+/gi;

/** Un rango de números: «18-22», «pp. 25-32», «2021-2023». No «978-3-16». */
const RANGO = /(?<![\w./‐-])(\d{1,4})-{1,2}(\d{1,4})(?![\w/‐-]|\.\d)/g;

/**
 * Las reglas, en orden. Cada una dice qué arregla, por si hay que explicarlo.
 *
 * Todas conservan las cifras, que es lo que `preparar.motor` exige de un
 * párrafo antes de dejarlo entrar.
 */
const REGLAS = [
  // Restos de Markdown pegados en Word: «## Anexo 1», «Tabla 1.1** *Matriz».
  // Con espacio entre los asteriscos a la fuerza: «***p < 0.001» es la nota
  // de significación de una tabla y se queda como está.
  [/^#{1,6}\s+/, ''],
  [/(?<=\S)\*\*\s+\*(?=\p{L})/gu, ' '],

  // El guion que no se parte (U+2011) y el guion de Unicode (U+2010) escritos
  // como carácter: Word los enseña igual que el normal, pero no los encuentra
  // al buscar y los traductores automáticos los siembran por todo el texto.
  [/[‐‑]/g, '-'],

  // «´» y «`» haciendo de apóstrofo: «Cohen´s».
  [/(?<=\p{L})[´`](?=\p{L})/gu, '’'],

  // Rangos con guion: van con raya corta (en dash).
  [RANGO, '$1–$2'],

  // Las pruebas y criterios con nombre de dos autores van con raya corta en
  // APA, como hace Rubriq: «Kruskal–Wallis», «Mann–Whitney».
  [
    /\b(Kruskal|Mann|Shapiro|Kolmogorov|Fornell|Pearson|Spearman|Levene|Welch|Games|Kaiser|Meyer|Bartlett)-(?=(?:Wallis|Whitney|Wilk|Smirnov|Larcker|Brown|Howell|Meyer|Olkin)\b)/g,
    '$1–',
  ],

  // La raya larga va pegada en inglés académico (APA, Chicago): «trend—not».
  [/\s+—\s+/g, '—'],

  // Una cita pegada a la palabra de delante: «AI(Ismaniati et al., 2025)».
  // Solo si lo de dentro tiene forma de cita —apellido y año—, para no partir
  // una fórmula («Ca(OH)2») ni una función («f(x)»).
  [/(?<=[\p{L}\p{N}])\((?=\p{Lu}[\p{L}'’-]+[^()]*?\b(?:1[89]|20)\d{2}[a-z]?\b[^()]*\))/gu, ' ('],

  // Espacio antes de la puntuación y dentro de paréntesis.
  [/(?<=\S)[  ]+(?=[,;])/g, ''],
  [/(?<=\S)[  ]+(?=[.:](?:\s|$))/g, ''],
  [/(?<=\S)[  ]+\)/g, ')'],
  [/\([  ]+(?=\S)/g, '('],

  // Espacios dobles.
  [/ {2,}/g, ' '],
];

/**
 * El texto con la tipografía arreglada.
 *
 * Lo que es URL, DOI o correo se aparta antes y vuelve igual: ahí un guion o
 * un punto no se discuten.
 */
function arreglar(texto) {
  const apartados = [];
  let limpio = String(texto).replace(INTOCABLE, (trozo) => {
    apartados.push(trozo);
    return `\u{F0000}${apartados.length - 1}\u{F0001}`;
  });

  for (const [regla, poner] of REGLAS) limpio = limpio.replace(regla, poner);

  return limpio.replace(/\u{F0000}(\d+)\u{F0001}/gu, (_, i) => apartados[Number(i)]);
}

module.exports = { arreglar, REGLAS };

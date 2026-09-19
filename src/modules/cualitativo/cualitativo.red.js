'use strict';

/**
 * La red de códigos: los datos y el guion de R que la dibuja.
 *
 * Cada código es un nodo, del tamaño de sus citas y del color de su categoría;
 * dos códigos se unen si coocurren en alguna cita, con una línea más gruesa
 * cuantas más compartan (ver `cualitativo.tablas`). R la dibuja con igraph y
 * ggplot2 en una sesión aparte del tesista (ver `cualitativo.informe`), así que
 * no se mezcla con el guion de su análisis cuantitativo.
 *
 * El guion es FIJO: aquí solo se escriben los dos CSV que lee. Ningún nombre de
 * código entra en el código de R, así que un código llamado `"); system("…`
 * es un texto más.
 */

const { coocurrencias, frecuencias } = require('./cualitativo.tablas');

const NODOS = 'red-nodos.csv';
const ENLACES = 'red-enlaces.csv';
const FIGURA = 'red-de-codigos.png';
/** Más nodos no se leen en una figura de media página. */
const MAXIMO_NODOS = 40;

/** Un valor de CSV, entre comillas y con las comillas dobladas. */
const valor = (texto) => `"${String(texto ?? '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;

/**
 * Los dos CSV de la red. Null si no hay nada codificado.
 *
 * Con muchos códigos se quedan los `MAXIMO_NODOS` con más citas, y se dice.
 */
function datos(entrevistas, codificacion) {
  const todos = frecuencias(entrevistas, codificacion).filter((c) => c.citas > 0);
  if (todos.length === 0) return null;

  const elegidos = [...todos].sort((a, b) => b.citas - a.citas).slice(0, MAXIMO_NODOS);
  const dentro = new Set(elegidos.map((c) => c.nombre));
  const pares = coocurrencias(codificacion).filter((p) => dentro.has(p.a) && dentro.has(p.b));

  const nodos = [
    'nombre,categoria,citas',
    ...elegidos.map((c) => [valor(c.nombre), valor(c.categoria ?? 'Sin categoría'), c.citas].join(',')),
  ].join('\n');
  const enlaces = ['a,b,n', ...pares.map((p) => [valor(p.a), valor(p.b), p.n].join(','))].join('\n');

  return {
    nodos: `${nodos}\n`,
    enlaces: `${enlaces}\n`,
    codigos: elegidos.length,
    omitidos: todos.length - elegidos.length,
    lazos: pares.length,
  };
}

/** El guion de R. Lee los dos CSV de la carpeta de la sesión y deja la figura. */
const GUION = `
suppressPackageStartupMessages({
  library(igraph)
  library(ggplot2)
  library(ggrepel)
})
nodos <- utils::read.csv("${NODOS}", fileEncoding = "UTF-8", stringsAsFactors = FALSE,
                         colClasses = c("character", "character", "numeric"))
enlaces <- utils::read.csv("${ENLACES}", fileEncoding = "UTF-8", stringsAsFactors = FALSE,
                           colClasses = c("character", "character", "numeric"))
# Los cortes de la leyenda, en números enteros: no hay media cita.
enteros <- function(l) unique(pmax(1, round(pretty(l))))
g <- graph_from_data_frame(enlaces, vertices = nodos, directed = FALSE)
set.seed(2024)
posicion <- if (ecount(g) > 0) layout_with_fr(g, weights = E(g)$n) else layout_in_circle(g)
puntos <- data.frame(nodos, x = posicion[, 1], y = posicion[, 2])
lineas <- if (nrow(enlaces) > 0) {
  data.frame(
    x = puntos$x[match(enlaces$a, puntos$nombre)], y = puntos$y[match(enlaces$a, puntos$nombre)],
    xend = puntos$x[match(enlaces$b, puntos$nombre)], yend = puntos$y[match(enlaces$b, puntos$nombre)],
    n = enlaces$n
  )
} else {
  data.frame(x = numeric(0), y = numeric(0), xend = numeric(0), yend = numeric(0), n = numeric(0))
}
figura <- ggplot() +
  geom_segment(data = lineas, aes(x = x, y = y, xend = xend, yend = yend, linewidth = n),
               colour = "grey60", alpha = 0.7) +
  geom_point(data = puntos, aes(x = x, y = y, size = citas, colour = categoria)) +
  geom_text_repel(data = puntos, aes(x = x, y = y, label = nombre), size = 3.2,
                  max.overlaps = Inf, box.padding = 0.4, seed = 2024) +
  scale_linewidth(range = c(0.3, 2.5), name = "Coocurrencias", breaks = enteros) +
  scale_size(range = c(3, 12), name = "Citas", breaks = enteros) +
  scale_x_continuous(expand = expansion(mult = 0.12)) +
  scale_y_continuous(expand = expansion(mult = 0.08)) +
  labs(colour = "Categoría") +
  theme_void(base_size = 11) +
  theme(legend.position = "right", plot.background = element_rect(fill = "white", colour = NA))
if (requireNamespace("ragg", quietly = TRUE)) {
  ggsave("${FIGURA}", figura, width = 9, height = 6.5, dpi = 200, device = ragg::agg_png, bg = "white")
} else {
  ggsave("${FIGURA}", figura, width = 9, height = 6.5, dpi = 200, bg = "white")
}
cat("Red de codigos:", vcount(g), "codigos,", ecount(g), "lazos\\n")
`.trim();

module.exports = { datos, GUION, NODOS, ENLACES, FIGURA, MAXIMO_NODOS };

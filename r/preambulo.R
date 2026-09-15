# Las funciones de la casa: las que una tesis necesita y R no trae con ese nombre.
#
# Son las mismas que tenia la pagina de analisis en el navegador, retirada el
# 15-sep-2026, para que un guion escrito alli corra igual aqui.
# Se cargan en cada ejecucion y NO se guardan con la sesion: asi, si se corrige
# una, la correccion llega a todas las sesiones sin tocar nada.
#
# Sin paquetes externos a proposito: el alfa de Cronbach son cinco lineas de
# formula y lo demas ya viene en `stats`.
#
# Probadas con Rscript contra la matriz de ejemplo: alfa 0,886, Shapiro
# p=0,148, Pearson r=0,511.

alfa_de_cronbach <- function(items) {
  items <- as.data.frame(items)
  items <- items[stats::complete.cases(items), , drop = FALSE]
  k <- ncol(items)

  if (k < 2) stop("El alfa necesita al menos dos items.")

  total <- rowSums(items)
  alfa <- (k / (k - 1)) * (1 - sum(apply(items, 2, stats::var)) / stats::var(total))

  por_item <- t(sapply(seq_len(k), function(i) {
    resto <- items[, -i, drop = FALSE]
    kk <- ncol(resto)
    sin_el <- if (kk < 2) NA else {
      (kk / (kk - 1)) * (1 - sum(apply(resto, 2, stats::var)) / stats::var(rowSums(resto)))
    }
    c(r_item_resto = stats::cor(items[, i], rowSums(resto)), alfa_si_se_quita = sin_el)
  }))

  rownames(por_item) <- names(items)

  cat("Alfa de Cronbach:", round(alfa, 3), "\n")
  cat("Items:", k, " Casos:", nrow(items), "\n\n")
  cat("Si el alfa SUBE al quitar un item, ese item mide otra cosa:\n")
  print(round(as.data.frame(por_item), 3))

  invisible(alfa)
}

frecuencias <- function(x, etiqueta = NULL) {
  x <- x[!is.na(x)]
  conteo <- table(x)
  tabla <- data.frame(
    categoria = names(conteo),
    n = as.integer(conteo),
    porcentaje = round(as.numeric(conteo) / length(x) * 100, 1)
  )
  tabla$acumulado <- cumsum(tabla$porcentaje)

  if (!is.null(etiqueta)) cat(etiqueta, "\n")
  print(tabla, row.names = FALSE)
  cat("Total:", length(x), "casos\n")

  invisible(tabla)
}

puntaje <- function(datos, columnas) {
  faltan <- setdiff(columnas, names(datos))
  if (length(faltan) > 0) {
    stop("Estas columnas no estan en tus datos: ", paste(faltan, collapse = ", "))
  }
  rowMeans(datos[, columnas, drop = FALSE], na.rm = TRUE)
}

# La etiqueta sale del nombre con el que se llamo: normalidad(datos$CD)
# escribe "datos$CD". force() va el primero: si no, la etiqueta se calcularia
# despues de limpiar los NA y se imprimirian los numeros en vez del nombre.
normalidad <- function(x, etiqueta = deparse(substitute(x))) {
  force(etiqueta)
  x <- x[!is.na(x)]
  n <- length(x)

  if (n < 3) stop("Hacen falta al menos tres casos.")
  if (n > 5000) stop("Shapiro-Wilk no admite mas de 5000 casos.")

  sw <- stats::shapiro.test(x)
  p <- sw$p.value

  cat("Shapiro-Wilk sobre", etiqueta, "\n")
  cat("  W =", round(sw$statistic, 4), "   p =", format.pval(p, digits = 4), "   n =", n, "\n\n")

  if (p >= 0.05) {
    cat("p >= 0.05: los datos NO se apartan de la normal.\n")
    cat("Puedes usar pruebas parametricas: Pearson, t de Student, ANOVA.\n")
  } else {
    cat("p < 0.05: los datos SI se apartan de la normal.\n")
    cat("Usa pruebas no parametricas: Spearman, Mann-Whitney, Kruskal-Wallis.\n")
  }

  invisible(sw)
}

descriptivos <- function(datos) {
  datos <- as.data.frame(datos)
  numericas <- datos[, sapply(datos, is.numeric), drop = FALSE]

  if (ncol(numericas) == 0) stop("No hay ninguna columna numerica.")

  resumen <- data.frame(
    n = sapply(numericas, function(x) sum(!is.na(x))),
    media = round(sapply(numericas, mean, na.rm = TRUE), 2),
    de = round(sapply(numericas, stats::sd, na.rm = TRUE), 2),
    minimo = sapply(numericas, min, na.rm = TRUE),
    maximo = sapply(numericas, max, na.rm = TRUE)
  )

  print(resumen)
  invisible(resumen)
}

# Pone el separador que Excel obedece (sep=;) y el decimal que se le pida. Con
# write.csv las columnas caen todas dentro de la A en un Excel en espanol.
escribir_csv <- function(datos, archivo = "resultados.csv",
                         dec = getOption("acosta.dec", ".")) {
  con <- file(archivo, open = "w", encoding = "UTF-8")
  on.exit(close(con))
  writeLines("sep=;", con)
  utils::write.table(datos, con, sep = ";", dec = dec, row.names = FALSE)
  cat("Guardado", archivo, "- pidele a Claude el enlace para descargarlo.", "\n")
  invisible(archivo)
}

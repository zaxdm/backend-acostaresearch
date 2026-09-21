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

# -- Mapeo bibliometrico ------------------------------------------------------
#
# Para cuando `datos` es un exporte de Scopus, WoS o PubMed leido con
# bibliometrix::convert2df (lo hace solo la subida). Llaman a bibliometrix con
# `::`, asi que no lo cargan hasta que se usan: el preambulo sigue sin coste
# para una tesis con su matriz.
#
# Cada figura se dibuja DOS veces con la misma semilla: una en su PNG, con el
# tamano que espera el informe en Word, y otra en el grafico de la sesion, para
# que Claude la vea. Y cada una imprime sus cifras: el informe comprueba que
# todo numero haya salido de la consola.

.palabras_de <- function(x) {
  x <- unlist(strsplit(x[!is.na(x)], ";"))
  x <- trimws(x)
  x[x != "" & x != "NA"]
}

.contar <- function(x, n) {
  conteo <- utils::head(sort(table(x), decreasing = TRUE), n)
  data.frame(nombre = names(conteo), documentos = as.integer(conteo), stringsAsFactors = FALSE)
}

.barras <- function(tabla, titulo, eje) {
  tabla$nombre <- factor(tabla$nombre, levels = rev(tabla$nombre))
  ggplot2::ggplot(tabla, ggplot2::aes(x = nombre, y = documentos)) +
    ggplot2::geom_col(fill = "#2F5D8A") +
    ggplot2::coord_flip() +
    ggplot2::labs(title = titulo, x = NULL, y = eje) +
    ggplot2::theme_minimal(base_size = 11)
}

.dibujar_y_guardar <- function(archivo, dibujo) {
  grDevices::png(archivo, width = 1600, height = 1100, res = 200)
  set.seed(1)
  tryCatch(dibujo(), finally = grDevices::dev.off())
  set.seed(1)
  resultado <- dibujo()
  cat("Figura guardada en", archivo, "\n")
  invisible(resultado)
}

# Lo que la lectura de OpenAlex deja a medias en bibliometrix 5.5: junta los
# paises con "; " (y sus funciones parten por ";", asi que " CHINA" y "CHINA"
# serian dos paises), y sin autor de correspondencia marcado deja vacio AU1_CO.
# Lo llama la subida, no Claude.
preparar_openalex <- function(M) {
  M$AU_CO <- gsub("\\s*;\\s*", ";", M$AU_CO)
  sin_pais <- is.na(M$AU1_CO) | M$AU1_CO == ""
  M$AU1_CO[sin_pais] <- sub(";.*", "", M$AU_CO[sin_pais])
  M
}

# Los paises de cada documento. En OpenAlex ya vienen de la fuente y NO se
# recalculan: metaTagExtraction los saca de las afiliaciones, que alli son solo
# nombres de institucion, y los dejaria vacios.
.con_paises <- function(M, campo) {
  de_openalex <- "DB" %in% names(M) && identical(toupper(M$DB[1]), "OPENALEX")
  if (de_openalex && campo %in% names(M) && any(!is.na(M[[campo]]) & M[[campo]] != "")) return(M)
  bibliometrix::metaTagExtraction(M, Field = campo, sep = ";")
}

resumen_bibliometrico <- function(M = datos, k = 10) {
  resultados <- bibliometrix::biblioAnalysis(M, sep = ";")
  # Sin `verbose`: en bibliometrix 5.5, nombrarlo (aunque sea TRUE) lo apaga y
  # summary no imprime nada.
  summary(resultados, k = k, pause = FALSE)
  invisible(resultados)
}

figura_bibliometrica <- function(tipo, M = datos, archivo = paste0("figura_", tipo, ".png"),
                                 n = NULL, campo = NULL, minfreq = NULL) {
  tipos <- c("produccion_anual", "fuentes", "autores", "paises", "palabras",
             "coocurrencia", "mapa_tematico", "cocitacion", "coautoria",
             "colaboracion_paises", "bradford", "lotka")
  if (!tipo %in% tipos) stop("Tipo no reconocido. Puede ser: ", paste(tipos, collapse = ", "))

  # Con muy pocos documentos, o si todos comparten pais, tema o nivel de
  # productividad, bibliometrix falla por dentro con mensajes que no dicen nada
  # ("argument is of length zero"). Se traduce a lo que pasa.
  tryCatch(
    .figura_bibliometrica(tipo, M, archivo, n, campo, minfreq),
    error = function(e) {
      while (grDevices::dev.cur() > 2L) grDevices::dev.off()
      # Un PNG a medias no puede acabar en el informe.
      if (file.exists(archivo)) unlink(archivo)
      stop("bibliometrix no pudo con '", tipo, "' sobre ", nrow(M), " documentos (",
           conditionMessage(e), "). Suele pasar con pocos documentos o cuando todos comparten ",
           "pais, tema o autor: deja fuera esta figura, o prueba otro campo o un n o minfreq menor.",
           call. = FALSE)
    }
  )
}

.figura_bibliometrica <- function(tipo, M, archivo, n, campo, minfreq) {
  # Las palabras clave de autor si el exporte las trae; si no, las de la base.
  if (is.null(campo)) {
    campo <- if ("DE" %in% names(M) && length(.palabras_de(M$DE)) > 0) "DE" else "ID"
  }
  red_de_palabras <- if (campo == "DE") "author_keywords" else "keywords"

  if (tipo == "produccion_anual") {
    anios <- as.data.frame(table(M$PY), stringsAsFactors = FALSE)
    names(anios) <- c("anio", "documentos")
    anios$anio <- as.integer(anios$anio)
    cat("Produccion cientifica anual\n")
    print(anios, row.names = FALSE)
    grafico <- ggplot2::ggplot(anios, ggplot2::aes(x = anio, y = documentos)) +
      ggplot2::geom_line(colour = "#2F5D8A", linewidth = 1) +
      ggplot2::geom_point(colour = "#2F5D8A", size = 2) +
      ggplot2::labs(title = "Produccion cientifica anual", x = "Anio", y = "Documentos") +
      ggplot2::theme_minimal(base_size = 11)
    .dibujar_y_guardar(archivo, function() print(grafico))
    return(invisible(anios))
  }

  if (tipo %in% c("fuentes", "autores", "paises", "palabras")) {
    n <- if (is.null(n)) 10 else n
    if (tipo == "fuentes") {
      tabla <- .contar(M$SO[!is.na(M$SO) & M$SO != ""], n)
      titulo <- "Fuentes mas relevantes"
    } else if (tipo == "autores") {
      tabla <- .contar(.palabras_de(M$AU), n)
      titulo <- "Autores mas productivos"
    } else if (tipo == "paises") {
      paises <- .con_paises(M, "AU1_CO")$AU1_CO
      tabla <- .contar(paises[!is.na(paises) & paises != ""], n)
      titulo <- "Pais del autor de correspondencia"
    } else {
      tabla <- .contar(.palabras_de(M[[campo]]), n)
      titulo <- if (campo == "DE") "Palabras clave de autor mas frecuentes" else "Palabras clave mas frecuentes"
    }
    cat(titulo, "\n")
    print(tabla, row.names = FALSE)
    grafico <- .barras(tabla, titulo, "Documentos")
    .dibujar_y_guardar(archivo, function() print(grafico))
    return(invisible(tabla))
  }

  if (tipo %in% c("coocurrencia", "cocitacion", "coautoria", "colaboracion_paises")) {
    n <- if (is.null(n)) 30 else n
    forma <- "fruchterman"
    if (tipo == "coocurrencia") {
      red <- bibliometrix::biblioNetwork(M, analysis = "co-occurrences", network = red_de_palabras, sep = ";")
      titulo <- "Red de coocurrencia de palabras clave"
    } else if (tipo == "cocitacion") {
      red <- bibliometrix::biblioNetwork(M, analysis = "co-citation", network = "references", sep = ";")
      titulo <- "Red de cocitacion"
    } else if (tipo == "coautoria") {
      red <- bibliometrix::biblioNetwork(M, analysis = "collaboration", network = "authors", sep = ";")
      titulo <- "Red de coautoria"
    } else {
      con_paises <- .con_paises(M, "AU_CO")
      red <- bibliometrix::biblioNetwork(con_paises, analysis = "collaboration", network = "countries", sep = ";")
      titulo <- "Colaboracion entre paises"
      forma <- "circle"
    }
    # Normalizada por asociacion, como la dibuja biblioshiny: sin eso, los
    # terminos mas frecuentes se llevan todos los enlaces.
    normalizar <- if (tipo %in% c("coocurrencia", "cocitacion")) "association" else NULL
    dibujo <- function() {
      bibliometrix::networkPlot(red, normalize = normalizar, n = min(n, nrow(red)), Title = titulo,
                                type = forma, labelsize = 0.7, size.cex = TRUE,
                                community.repulsion = 0.05, remove.isolates = TRUE, verbose = TRUE)
    }
    resultado <- .dibujar_y_guardar(archivo, dibujo)
    grupos <- resultado$cluster_res
    if (!is.null(grupos) && nrow(grupos) > 0) {
      cat(titulo, "- nodos y su cluster (", length(unique(grupos$cluster)), "clusters )\n")
      print(utils::head(grupos[order(grupos$cluster, -grupos$pagerank_centrality), ], 40), row.names = FALSE)
    }
    return(invisible(resultado))
  }

  if (tipo == "mapa_tematico") {
    if (is.null(minfreq)) minfreq <- max(2, min(5, ceiling(nrow(M) / 100)))
    mapa <- bibliometrix::thematicMap(M, field = campo, n = if (is.null(n)) 250 else n,
                                      minfreq = minfreq, size = 0.5, repel = TRUE)
    if (is.null(mapa$map)) stop("No hay palabras que se repitan al menos ", minfreq, " veces: baja minfreq.")
    cat("Mapa tematico sobre", campo, "con minfreq =", minfreq, "\n")
    cat("Motor: centralidad y densidad altas. Nicho: densidad alta, centralidad baja.\n")
    cat("Emergente o en declive: las dos bajas. Basico: centralidad alta, densidad baja.\n")
    print(mapa$clusters[, c("name", "freq", "rcentrality", "rdensity")], row.names = FALSE)
    .dibujar_y_guardar(archivo, function() print(mapa$map))
    return(invisible(mapa))
  }

  if (tipo == "bradford") {
    b <- bibliometrix::bradford(M)
    cat("Ley de Bradford: fuentes por zona\n")
    print(table(b$table$Zone))
    cat("\nNucleo (Zona 1):\n")
    print(b$table[b$table$Zone == "Zone 1", c("SO", "Freq")], row.names = FALSE)
    .dibujar_y_guardar(archivo, function() print(b$graph))
    return(invisible(b))
  }

  # lotka. Las columnas se leen por posicion: bibliometrix las renombra entre
  # versiones ("Documents written", "N. of Authors", "Proportion of Authors").
  l <- bibliometrix::lotka(M)
  prod <- data.frame(documentos = as.numeric(l$AuthorProd[[1]]),
                     autores = as.integer(l$AuthorProd[[2]]),
                     observada = as.numeric(l$AuthorProd[[3]]))
  prod$ajustada <- as.numeric(l$fitted)[seq_len(nrow(prod))]
  cat("Ley de Lotka: autores segun cuantos documentos firman\n")
  print(prod, row.names = FALSE)
  cat("Beta =", round(l$Beta, 3), "  C =", round(l$C, 3), "  R2 =", round(l$R2, 3),
      "  p (K-S, Lotka teorica) =", format.pval(l$p.value, digits = 3), "\n")
  grafico <- ggplot2::ggplot(prod, ggplot2::aes(x = documentos)) +
    ggplot2::geom_line(ggplot2::aes(y = observada, colour = "Observada"), linewidth = 1) +
    ggplot2::geom_line(ggplot2::aes(y = ajustada, colour = "Ajustada"), linetype = "dashed") +
    ggplot2::scale_colour_manual(values = c(Observada = "#2F5D8A", Ajustada = "#B5523B")) +
    ggplot2::labs(title = "Productividad de los autores (Lotka)", x = "Documentos por autor",
                  y = "Proporcion de autores", colour = NULL) +
    ggplot2::theme_minimal(base_size = 11)
  .dibujar_y_guardar(archivo, function() print(grafico))
  invisible(l)
}

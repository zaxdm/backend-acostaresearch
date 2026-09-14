# Ejecuta UNA orden de una sesion de R del conector, y termina.
#
# COMO SE USA
# -----------
# El backend deja el codigo en `orden.R`, dentro de la carpeta de la sesion, y
# arranca este guion con esa carpeta como directorio de trabajo:
#
#   - en el servidor, dentro de la jaula de systemd (infra/r/acostaresearch-r@.service);
#   - en desarrollo, con Rscript directamente.
#
# Deja en la misma carpeta:
#
#   salida.txt    lo que se vio en la consola, con el eco de cada orden
#   estado.tsv    los objetos de la sesion y las columnas de `datos`
#   graficos/     un PNG por cada grafico que se dibujo
#   entorno.RData los objetos, para la siguiente orden
#   paquetes.txt  los paquetes cargados con library(), para la siguiente orden
#   fin           "ok" o "error". Si NO existe, el proceso se corto: tiempo o memoria.
#
# POR QUE UN PROCESO POR ORDEN Y NO UNA SESION VIVA
# -------------------------------------------------
# Un R esperando ordenes es memoria ocupada aunque nadie trabaje, y un proceso
# de larga vida que ejecuta codigo ajeno es justo lo que no se quiere tener en
# marcha. Arrancar R cuesta menos de un segundo, `entorno.RData` conserva los
# objetos y `paquetes.txt` los library(): entre las dos cosas, el tesista ve
# "la sesion" como la veria en RStudio.
#
# Todo va dentro de local() para que ninguna variable de este guion acabe en el
# entorno del tesista. Sin tildes en este archivo: se lee igual en cualquier
# locale.

local({
  argumentos <- commandArgs(trailingOnly = FALSE)
  propio <- sub("^--file=", "", grep("^--file=", argumentos, value = TRUE)[1L])
  preambulo <- file.path(dirname(normalizePath(propio, winslash = "/", mustWork = TRUE)), "preambulo.R")

  for (viejo in c("salida.txt", "estado.tsv", "fin")) {
    if (file.exists(viejo)) unlink(viejo)
  }

  salida <- file("salida.txt", open = "wt", encoding = "UTF-8")
  sink(salida)
  sink(salida, type = "message")

  options(
    warn = 1,
    width = 100,
    max.print = 500,
    useFancyQuotes = FALSE,
    OutDec = ".",
    acosta.dec = "."
  )

  if (file.exists("entorno.RData")) {
    tryCatch(
      load("entorno.RData", envir = globalenv()),
      error = function(e) {
        cat("No se pudo recuperar la sesion anterior:", conditionMessage(e), "\n")
      }
    )
  }

  # Los paquetes de ordenes anteriores se vuelven a cargar, en el mismo orden.
  # Sin esto, un library(psych) de hace dos mensajes dejaria de valer sin avisar
  # y Claude se encontraria con "no se encontro la funcion alpha".
  if (file.exists("paquetes.txt")) {
    for (paquete in readLines("paquetes.txt", warn = FALSE)) {
      if (!nzchar(paquete)) next
      tryCatch(
        suppressPackageStartupMessages(library(paquete, character.only = TRUE)),
        error = function(e) cat("No se pudo volver a cargar el paquete", paquete, "\n")
      )
    }
  }

  # Las de la casa se cargan SIEMPRE, encima de lo recuperado: si se corrige una,
  # la correccion llega a todas las sesiones.
  casa <- new.env()
  sys.source(preambulo, envir = casa)
  for (nombre in ls(casa)) assign(nombre, get(nombre, envir = casa), envir = globalenv())

  dir.create("graficos", showWarnings = FALSE)
  plantilla <- file.path("graficos", "grafico-%02d.png")
  if (isTRUE(capabilities("cairo"))) {
    grDevices::png(plantilla, width = 1000, height = 700, res = 120, type = "cairo")
  } else {
    grDevices::png(plantilla, width = 1000, height = 700, res = 120)
  }

  resultado <- "ok"

  expresiones <- tryCatch(
    parse("orden.R", keep.source = TRUE, encoding = "UTF-8"),
    error = function(e) {
      cat("Error de sintaxis: ", conditionMessage(e), "\n", sep = "")
      NULL
    }
  )
  if (is.null(expresiones)) resultado <- "error"
  fuentes <- attr(expresiones, "srcref")

  # Una expresion detras de otra, como la consola: eco, resultado, y al primer
  # error se para, igual que source().
  for (i in seq_along(expresiones)) {
    texto <- if (!is.null(fuentes)) as.character(fuentes[[i]]) else deparse(expresiones[[i]])
    cat(paste0(c("> ", rep("+ ", length(texto) - 1L)), texto), sep = "\n")

    fallo <- FALSE
    tryCatch(
      withCallingHandlers(
        {
          visible <- withVisible(eval(expresiones[[i]], envir = globalenv()))
          if (visible$visible) {
            if (isS4(visible$value)) methods::show(visible$value) else print(visible$value)
          }
        },
        warning = function(w) {
          cat("Warning: ", conditionMessage(w), "\n", sep = "")
          invokeRestart("muffleWarning")
        }
      ),
      error = function(e) {
        llamada <- conditionCall(e)
        prefijo <- if (is.null(llamada)) {
          "Error: "
        } else {
          paste0("Error in ", paste(deparse(llamada, nlines = 1L), collapse = ""), " : ")
        }
        cat(prefijo, conditionMessage(e), "\n", sep = "")
        fallo <<- TRUE
      }
    )
    flush(salida)

    if (fallo) {
      resultado <- "error"
      break
    }
  }

  tryCatch(
    {
      # Cierra tambien los que abrio el tesista con png() y olvido cerrar: sin
      # esto, su archivo se queda vacio.
      while (grDevices::dev.cur() > 1L) grDevices::dev.off()

      # Los paquetes cargados, del mas antiguo al mas reciente, para volver a
      # cargarlos en el mismo orden (el ultimo cargado es el que manda si dos
      # funciones se llaman igual).
      de_serie <- c("stats", "graphics", "grDevices", "utils", "datasets", "methods", "base")
      writeLines(setdiff(rev(.packages()), de_serie), "paquetes.txt")

      # Las de la casa no se guardan, salvo que el tesista las haya cambiado.
      for (nombre in ls(casa)) {
        if (exists(nombre, envir = globalenv(), inherits = FALSE) &&
            identical(get(nombre, envir = globalenv()), get(nombre, envir = casa))) {
          rm(list = nombre, envir = globalenv())
        }
      }

      save(
        list = ls(globalenv(), all.names = TRUE),
        envir = globalenv(),
        file = "entorno.RData.parcial"
      )
      file.rename("entorno.RData.parcial", "entorno.RData")

      limpiar <- function(x) gsub("[\t\r\n]", " ", x)
      lineas <- character()

      for (nombre in ls(globalenv())) {
        valor <- get(nombre, envir = globalenv())
        detalle <- if (is.data.frame(valor)) {
          sprintf("%d x %d", nrow(valor), ncol(valor))
        } else if (is.function(valor)) {
          "funcion"
        } else if (is.atomic(valor)) {
          sprintf("%s %d", typeof(valor), length(valor))
        } else if (is.list(valor)) {
          sprintf("lista %d", length(valor))
        } else {
          ""
        }
        lineas <- c(lineas, paste("obj", limpiar(nombre), limpiar(class(valor)[1L]), limpiar(detalle), sep = "\t"))
      }

      # Solo la ESTRUCTURA de `datos`: nombre, tipo, perdidos y rango. Ningun
      # valor de ninguna persona.
      if (exists("datos", envir = globalenv(), inherits = FALSE) &&
          is.data.frame(get("datos", envir = globalenv()))) {
        tabla <- get("datos", envir = globalenv())
        for (columna in names(tabla)) {
          x <- tabla[[columna]]
          resumen <- if (is.numeric(x) && any(!is.na(x))) {
            paste(format(min(x, na.rm = TRUE), digits = 4), format(max(x, na.rm = TRUE), digits = 4))
          } else if (is.character(x) || is.factor(x) || is.logical(x)) {
            as.character(length(unique(x[!is.na(x)])))
          } else {
            ""
          }
          lineas <- c(lineas, paste(
            "col", limpiar(columna), limpiar(class(x)[1L]), sum(is.na(x)), limpiar(resumen),
            sep = "\t"
          ))
        }
      }

      estado <- file("estado.tsv", open = "wt", encoding = "UTF-8")
      writeLines(lineas, estado)
      close(estado)
    },
    error = function(e) {
      cat("No se pudo guardar la sesion: ", conditionMessage(e), "\n", sep = "")
      resultado <<- "error"
    }
  )

  sink(type = "message")
  sink()
  close(salida)

  writeLines(resultado, "fin")
})

quit(save = "no", status = 0)

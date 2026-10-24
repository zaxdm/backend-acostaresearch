'use strict';

/**
 * SPSS en la conversación: la sintaxis de SPSS que manda Claude se ejecuta de
 * verdad en PSPP, el programa libre de GNU que entiende esa misma sintaxis.
 *
 * POR QUÉ PSPP Y NO SPSS
 * ----------------------
 * Muchos asesores piden el análisis «en SPSS». El SPSS de IBM se paga por
 * persona y su licencia no deja ofrecerlo como servicio, así que no puede
 * correr en el servidor para tesistas de todo el mundo. PSPP sí: es libre,
 * lee y escribe .sav y ejecuta la misma sintaxis. Lo que PSPP no tiene
 * (ecuaciones estructurales, PLS-SEM, modelos mixtos) se sigue haciendo en R.
 * El informe dice «procesado con PSPP, compatible con IBM SPSS», nunca que se
 * usó IBM SPSS.
 *
 * CÓMO VA UNA ORDEN
 * -----------------
 *   1. R pasa los datos de la sesión —`datos`, con lo que se haya calculado en
 *      R— a `datos-spss.sav`, con las etiquetas del .sav original si lo subió
 *      en SPSS. Va en la jaula de R de siempre (`EXPORTAR`).
 *   2. Se escribe `orden.sps`: abrir ese .sav y la sintaxis de Claude.
 *   3. PSPP la ejecuta en su propia jaula (infra/r/pspp.conf), gemela de la de
 *      R: sin red, sin secretos, solo su carpeta, y con --safer, que quita HOST,
 *      ERASE y las tuberías.
 *
 * Al tesista le quedan para bajar el .sav, la sintaxis acumulada
 * (`sintaxis.sps`) para repetirlo en su SPSS, y las tablas en `.odt`, que abre
 * Word.
 */

/** Los datos de la sesión en formato SPSS, y lo que PSPP deja. */
const SAV = 'datos-spss.sav';
const ORDEN = 'orden.sps';
const SALIDA = 'salida-spss.txt';
const ERRORES = 'errores-spss.txt';
const TABLAS = 'resultados-spss.odt';
const SINTAXIS = 'sintaxis.sps';

const CABECERA_SINTAXIS =
  '* Sintaxis de SPSS escrita en la conversación con Claude y ejecutada en PSPP.\n' +
  '* Para repetirla en SPSS o PSPP: pon datos-spss.sav en la misma carpeta que este archivo.\n\n' +
  `GET FILE='${SAV}'.\n`;

/**
 * El R que pasa `datos` a .sav. Corre en la jaula de R, con la sesión cargada.
 *
 * Los nombres de R no siempre valen en SPSS: «edad..años.» acaba en punto,
 * «AND» es palabra reservada, y SPSS corta en 64 bytes. Los que se cambian se
 * imprimen con RENOMBRADA para que Claude use el nombre nuevo. Las etiquetas
 * de valor del .sav original se vuelven a poner: al subirlo se quitaron para
 * que R trabajara con números, y en las tablas de SPSS son lo que se lee.
 */
const EXPORTAR = `local({
  if (!exists("datos", envir = globalenv()) || !is.data.frame(get("datos", envir = globalenv()))) {
    stop("No hay una tabla 'datos' en la sesion")
  }
  d <- as.data.frame(get("datos", envir = globalenv()))
  if (file.exists("datos.sav")) {
    original <- tryCatch(haven::read_sav("datos.sav"), error = function(e) NULL)
    if (!is.null(original)) {
      names(original) <- make.names(names(original), unique = TRUE)
      for (n in intersect(names(d), names(original))) {
        etiquetas <- attr(original[[n]], "labels", exact = TRUE)
        rotulo <- attr(original[[n]], "label", exact = TRUE)
        if (is.numeric(d[[n]]) && is.numeric(etiquetas)) {
          d[[n]] <- tryCatch(
            haven::labelled(as.double(d[[n]]), labels = stats::setNames(as.double(etiquetas), names(etiquetas)), label = rotulo),
            error = function(e) d[[n]]
          )
        } else if (!is.null(rotulo)) {
          attr(d[[n]], "label") <- rotulo
        }
      }
    }
  }
  reservadas <- c("ALL", "AND", "BY", "EQ", "GE", "GT", "LE", "LT", "NE", "NOT", "OR", "TO", "WITH")
  viejos <- names(d)
  nuevos <- gsub("[^\\\\p{L}\\\\p{N}_.@#$]", "_", enc2utf8(viejos), perl = TRUE)
  nuevos <- sub("[.]+$", "", nuevos)
  nuevos <- ifelse(grepl("^[\\\\p{L}@#$]", nuevos, perl = TRUE), nuevos, paste0("v", nuevos))
  nuevos <- ifelse(toupper(nuevos) %in% reservadas, paste0(nuevos, "_"), nuevos)
  nuevos <- vapply(nuevos, function(x) {
    while (nchar(x, type = "bytes") > 60) x <- substr(x, 1, nchar(x) - 1)
    x
  }, "", USE.NAMES = FALSE)
  nuevos <- make.unique(nuevos, sep = "_")
  for (i in which(viejos != nuevos)) cat("RENOMBRADA", viejos[i], "->", nuevos[i], "\\n")
  names(d) <- nuevos
  haven::write_sav(d, "${SAV}")
  cat("SPSS-LISTO", nrow(d), "casos", ncol(d), "variables\\n")
})`;

/** Lo que la sesión de R dice que renombró: [{ antes, ahora }]. */
function renombradas(salida) {
  const lista = [];
  for (const [, antes, ahora] of String(salida ?? '').matchAll(/^RENOMBRADA (\S+) -> (\S+)\s*$/gm)) {
    lista.push({ antes, ahora });
  }
  return lista;
}

// ── El filtro ───────────────────────────────────────────────────────────────

/**
 * Los comandos que no se dejan, al principio de un comando. PSPP con --safer
 * ya rechaza HOST, ERASE y las tuberías; esto los para antes, con un motivo
 * que Claude entiende, y añade los que leen otros archivos de sintaxis o
 * cambian de carpeta.
 */
const COMANDOS = [
  { regla: 'spss-host', motivo: 'ejecuta un programa del sistema', patron: /^\s*HOST\b/im },
  { regla: 'spss-borrar', motivo: 'borra archivos', patron: /^\s*ERASE\b/im },
  { regla: 'spss-permisos', motivo: 'cambia los permisos de un archivo', patron: /^\s*PERMISSIONS\b/im },
  { regla: 'spss-incluir', motivo: 'ejecuta otro archivo de sintaxis', patron: /^\s*(?:INCLUDE|INSERT)\b/im },
  { regla: 'spss-carpeta', motivo: 'cambia de carpeta', patron: /^\s*CD\b/im },
  { regla: 'spss-archivos', motivo: 'define accesos a archivos de fuera', patron: /^\s*FILE\s+HANDLE\b/im },
];

/** Un nombre de archivo de su carpeta: sin barras, sin «..», sin tuberías. */
const ARCHIVO_PROPIO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const RUTA = /\b(?:FILE|OUTFILE|INFILE|TABLE)\s*=\s*(['"])(.*?)\1/gi;

/** null si la sintaxis puede ejecutarse; si no, qué regla la para y por qué. */
function revisar(sintaxis) {
  const texto = String(sintaxis ?? '');

  for (const { regla, motivo, patron } of COMANDOS) {
    const hallado = patron.exec(texto);
    if (hallado) return { regla, motivo, fragmento: hallado[0].trim().slice(0, 60) };
  }

  for (const [completo, , archivo] of texto.matchAll(RUTA)) {
    if (!ARCHIVO_PROPIO.test(archivo) || archivo.includes('..')) {
      return {
        regla: 'spss-ruta',
        motivo: 'sale de la carpeta de trabajo del tesista',
        fragmento: completo.slice(0, 60),
      };
    }
  }

  return null;
}

/** Lo que se le da a PSPP: abrir los datos de la sesión y la sintaxis tal cual. */
function armarOrden(sintaxis) {
  return `GET FILE='${SAV}'.\n${String(sintaxis).replace(/\r\n?/g, '\n').trim()}\n`;
}

/** ¿Hay errores en lo que PSPP dejó en su archivo de mensajes? */
function hayErrores(mensajes) {
  return /(?:^|[\s:])error:/im.test(String(mensajes ?? ''));
}

module.exports = {
  SAV,
  ORDEN,
  SALIDA,
  ERRORES,
  TABLAS,
  SINTAXIS,
  CABECERA_SINTAXIS,
  EXPORTAR,
  renombradas,
  revisar,
  armarOrden,
  hayErrores,
};

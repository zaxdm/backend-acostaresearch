#!/usr/bin/env bash
#
# Intenta escapar de la jaula de R, como lo intentaría un tesista con malas
# intenciones, y dice si lo consigue. Todos deben salir OK.
#
# Uso (como root):  bash /opt/acostaresearch/app/infra/r/probar-jaula.sh
#
# Las órdenes se lanzan COMO EL USUARIO DE LA API y por el mismo camino que usa
# el backend (systemctl start de la plantilla), así que también se comprueba
# que polkit le deja arrancarla. No toca ninguna sesión de ningún tesista: usa
# una carpeta propia y la borra al terminar.
set -uo pipefail

SESIONES=/var/lib/acostaresearch-r/sesiones
ID="prueba-jaula-$$"
CARPETA="$SESIONES/$ID"
FALLOS=0

limpiar() { rm -rf "$CARPETA"; }
trap limpiar EXIT

sudo -u acosta mkdir -m 2770 "$CARPETA"

# ejecutar "<código R>"  →  deja la consola en $SALIDA y lo que tardó en $SEGUNDOS
ejecutar() {
  rm -f "$CARPETA/fin" "$CARPETA/salida.txt"
  printf '%s\n' "$1" | sudo -u acosta tee "$CARPETA/orden.R" >/dev/null
  local inicio=$SECONDS
  sudo -u acosta systemctl start --no-ask-password "acostaresearch-r@$ID.service" 2>/tmp/jaula-err-$$ || true
  SEGUNDOS=$((SECONDS - inicio))
  SALIDA="$(cat "$CARPETA/salida.txt" 2>/dev/null; cat /tmp/jaula-err-$$ 2>/dev/null)"
  rm -f /tmp/jaula-err-$$
}

comprobar() {
  local nombre="$1" condicion="$2"
  if eval "$condicion"; then
    echo "  OK    $nombre"
  else
    echo "  FALLO $nombre"
    echo "$SALIDA" | tail -5 | sed 's/^/        /'
    FALLOS=$((FALLOS + 1))
  fi
}

echo "── Funciona ──"
ejecutar 'cat("suma:", 1 + 1, "\n")'
comprobar "polkit deja arrancar la jaula y R responde" '[ -f "$CARPETA/fin" ] && grep -q "suma: 2" <<<"$SALIDA"'
ejecutar 'x <- rnorm(50); png("prueba.png"); hist(x); invisible(dev.off()); cat(file.exists("prueba.png"), "\n")'
comprobar "puede dibujar y guardar en su carpeta" 'grep -q "TRUE" <<<"$SALIDA"'
comprobar "lo que escribe R lo lee la API" 'sudo -u acosta test -r "$CARPETA/prueba.png"'
# Cada paquete que deja el filtro, cargado de verdad y en su propia orden, como
# lo haría Claude. Estar instalado no basta: semPlot lo estaba y no cargaba,
# porque al cargarse lanza un proceso y la jaula no lo deja. Todos a la vez en
# una sola orden pasarían de 400 MB. Tarda un par de minutos.
FALLAN=""
for p in readxl haven writexl openxlsx flextable officer tidyverse dplyr tidyr readr forcats stringr purrr tibble lubridate magrittr glue scales ggplot2 ggpubr gridExtra cowplot ggrepel corrplot psych GPArotation psy lavaan semTools car carData rstatix nortest effectsize performance parameters insight datawizard bayestestR broom emmeans lme4 rio knitr patchwork skimr kableExtra sjPlot sjmisc sjstats ggeffects GGally ggthemes viridis ggalluvial dendextend mice Hmisc pwr coin multcomp lmerTest ordinal pscl polycor vcd eRm qgraph epitools epiR pROC survminer metafor survey plm AER lmtest sandwich forecast tseries urca zoo xts vegan ade4 FactoMineR factoextra randomForest glmnet e1071 caret tidytext tm NLP SnowballC wordcloud survival MASS semPlot nFactors paran mirt ltm difR irr MVN seminr cSEM plspm moments DescTools BayesFactor gtsummary apaTables janitor meta fixest panelr pdynmc agricolae sf terra quanteda quanteda.textstats quanteda.textplots topicmodels; do
  rm -f "$CARPETA/paquetes.txt" "$CARPETA/entorno.RData"
  ejecutar "suppressPackageStartupMessages(library($p)); cat(\"CARGA-OK\\n\")"
  grep -q "CARGA-OK" <<<"$SALIDA" || FALLAN="$FALLAN $p"
done
rm -f "$CARPETA/paquetes.txt" "$CARPETA/entorno.RData"
SALIDA="no cargan:$FALLAN"
comprobar "cada paquete permitido carga dentro de la jaula" '[ -z "$FALLAN" ]'
ejecutar 'suppressPackageStartupMessages({ library(lavaan); library(psych) }); ajuste <- cfa("visual =~ x1 + x2 + x3", data = HolzingerSwineford1939); cat("cfi:", round(fitMeasures(ajuste, "cfi"), 3), "\n"); cat("alfa:", round(psych::alpha(HolzingerSwineford1939[, c("x1","x2","x3")])$total$raw_alpha, 3), "\n")'
comprobar "lavaan y psych cargan y calculan dentro de la jaula" 'grep -q "cfi:" <<<"$SALIDA" && grep -q "alfa:" <<<"$SALIDA"'
ejecutar 'cat("psych sigue cargado:", "package:psych" %in% search(), "\n")'
comprobar "los library() se recuerdan en la orden siguiente" 'grep -q "psych sigue cargado: TRUE" <<<"$SALIDA"'
ejecutar 'suppressPackageStartupMessages(library(ggplot2)); print(ggplot(mtcars, aes(wt, mpg)) + geom_point()); cat("ggplot ok\n")'
comprobar "ggplot2 dibuja dentro de la jaula" 'grep -q "ggplot ok" <<<"$SALIDA" && ls "$CARPETA"/graficos/grafico-*.png >/dev/null 2>&1'

echo "── Secretos ──"
ejecutar 'print(names(Sys.getenv()))'
comprobar "el entorno no trae secretos" '! grep -Eq "DATABASE_URL|JWT_|PAYPAL|SMTP|API_KEY|SECRET" <<<"$SALIDA"'
ejecutar 'print(tryCatch(readLines("/opt/acostaresearch/app/.env"), error = function(e) "BLOQUEADO"))'
comprobar "no ve el .env" 'grep -q "BLOQUEADO" <<<"$SALIDA"'
ejecutar 'print(list.files("/opt", recursive = TRUE)); print(list.files("/var/lib/acostaresearch", recursive = TRUE))'
comprobar "no ve el código ni las tesis de nadie" '! grep -Eq "server\.js|\.env|comprobantes|capitulos|\.md\"" <<<"$SALIDA"'
ejecutar 'print(list.files("/var/lib/acostaresearch-r/sesiones"))'
comprobar "no ve las otras sesiones" '! grep -q "prueba-jaula" <<<"$SALIDA" || [ "$(grep -c . <<<"$SALIDA")" -le 3 ]'
ejecutar 'print(tryCatch(system("cat /etc/shadow", intern = TRUE), error = function(e) "BLOQUEADO", warning = function(w) "BLOQUEADO"))'
comprobar "no lee /etc/shadow ni con system()" '! grep -q "root:" <<<"$SALIDA"'

echo "── Red ──"
ejecutar 'print(tryCatch({ con <- socketConnection("1.1.1.1", 80, timeout = 3); "CONECTADO" }, error = function(e) "SIN RED", warning = function(w) "SIN RED"))'
comprobar "no sale a internet" 'grep -q "SIN RED" <<<"$SALIDA"'
ejecutar 'print(tryCatch({ con <- socketConnection("127.0.0.1", 3000, timeout = 3); "CONECTADO" }, error = function(e) "SIN RED", warning = function(w) "SIN RED"))'
comprobar "no llega a la API por localhost" 'grep -q "SIN RED" <<<"$SALIDA"'

echo "── Recursos ──"
ejecutar 'x <- numeric(2e8); cat("RESERVADO\n")'
comprobar "no pasa de 400 MB" '! grep -q "RESERVADO" <<<"$SALIDA"'
ejecutar 'while (TRUE) {}'
comprobar "un bucle infinito se corta a los 45 s" '[ ! -f "$CARPETA/fin" ] && [ "$SEGUNDOS" -le 60 ]'
ejecutar 'for (i in 1:60) system("sleep 20 &"); cat("LANZADOS\n")'
comprobar "no puede multiplicar procesos" '[ "$(systemctl show -p TasksMax --value "acostaresearch-r@$ID.service")" = "16" ]'

echo "── Desde las restricciones de la API ──"
# Lo de arriba lanza la jaula con sudo, que no lleva las restricciones de
# acostaresearch.service. Con ellas (RestrictSUIDSGID, ProtectSystem=strict…)
# una carpeta creada con el bit setgid da EPERM y en ninguna otra prueba se
# ve: pasó el 14-sep-2026, y la herramienta decía «no disponible» sin crear
# nada. Esto sube datos y ejecuta con el motor de verdad y esas restricciones.
DIAG="/opt/acostaresearch/diag-jaula-$$.js"
cat > "$DIAG" <<'J'
const { crearMotor, conductorSystemd } = require('/opt/acostaresearch/app/src/modules/r/r.motor');
const motor = crearMotor({
  carpetaBase: '/var/lib/acostaresearch-r/sesiones',
  conductor: conductorSystemd({ limiteSegundos: 45 }),
});
const sesion = process.argv[2];
motor
  .subirDatos(sesion, { archivo: 'datos.csv', contenido: Buffer.from('a,b\n1,2\n'), lectura: 'datos <- read.csv("datos.csv")' })
  .then((r) => {
    console.log('SUBIDA ' + r.resultado);
    return motor.ejecutar(sesion, 'cat("columnas:", ncol(datos), "\\n")');
  })
  .then((r) => console.log(r.salida))
  .catch((e) => console.log('ERROR ' + e.constructor.name + ' ' + e.message));
J
chmod 644 "$DIAG"
SALIDA="$(systemd-run --wait --pipe --quiet \
  -p User=acosta -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes \
  -p RestrictSUIDSGID=yes -p UMask=0022 -p WorkingDirectory=/opt/acostaresearch/app \
  -p ReadWritePaths=/var/lib/acostaresearch -p ReadWritePaths="$SESIONES" \
  /usr/bin/node "$DIAG" "$ID-api" 2>&1)"
rm -f "$DIAG"
rm -rf "$SESIONES/$ID-api"
comprobar "la API sube datos y ejecuta R con sus propias restricciones" \
  'grep -q "SUBIDA ok" <<<"$SALIDA" && grep -q "columnas: 2" <<<"$SALIDA"'

echo "── La API sigue viva ──"
comprobar "acostaresearch sigue activo" 'systemctl is-active --quiet acostaresearch'

echo
if [ "$FALLOS" -eq 0 ]; then
  echo "La jaula aguanta: todas las pruebas OK."
else
  echo "$FALLOS PRUEBAS FALLARON. No actives R para los tesistas hasta arreglarlo."
  exit 1
fi

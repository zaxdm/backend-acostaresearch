#!/usr/bin/env bash
#
# Instala R y su jaula en el servidor. Se puede repetir sin romper nada.
#
# Uso (como root, DESPUÉS de desplegar el código que trae esta carpeta):
#
#   bash /opt/acostaresearch/app/infra/r/instalar.sh
#
# Qué hace:
#   1. Instala R base, los paquetes recomendados y readxl (de los repositorios
#      de Ubuntu: nada se baja de CRAN).
#   2. Crea el usuario «acosta-r», sin shell ni casa, y mete a «acosta» —el de la
#      API— en su grupo: así el backend lee lo que escribe R y R no lee nada del
#      backend.
#   3. Crea /var/lib/acostaresearch-r/sesiones con los permisos que la jaula
#      espera.
#   4. Copia la unidad, el slice y la regla de polkit.
#   5. Añade 2 GB de swap si no hay ninguno: el VPS no tenía, y sin swap un pico
#      de memoria lo resuelve el kernel matando procesos, que puede ser la API.
#   6. Reinicia la API, para que coja el grupo nuevo.
#
# Después, `bash infra/r/probar-jaula.sh` comprueba que la jaula aguanta.
set -euo pipefail

APP=/opt/acostaresearch/app
ORIGEN="$APP/infra/r"
SESIONES=/var/lib/acostaresearch-r/sesiones

[ "$(id -u)" = "0" ] || { echo "Hay que ejecutarlo como root."; exit 1; }
[ -f "$APP/r/ejecutar.R" ] || { echo "Falta $APP/r/ejecutar.R: despliega antes el código."; exit 1; }

echo "── R ──"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# Todos de los repositorios de Ubuntu, ya compilados: nada se compila aquí.
# No están (y no se compilan): moments, DescTools, MVN, irr, apaTables y mirt;
# psych y rstatix cubren lo que se usa de ellos en una tesis.
apt-get install -y -qq --no-install-recommends \
  r-base-core r-recommended \
  r-cran-readxl r-cran-haven r-cran-writexl r-cran-openxlsx r-cran-flextable r-cran-officer \
  r-cran-tidyverse r-cran-dplyr r-cran-tidyr r-cran-readr r-cran-forcats r-cran-stringr \
  r-cran-purrr r-cran-tibble r-cran-ggplot2 r-cran-ggpubr r-cran-corrplot \
  r-cran-psych r-cran-gparotation r-cran-psy r-cran-lavaan r-cran-semtools \
  r-cran-car r-cran-rstatix r-cran-nortest r-cran-effectsize r-cran-performance \
  r-cran-broom r-cran-emmeans r-cran-lme4 \
  r-cran-patchwork r-cran-skimr r-cran-kableextra r-cran-sjplot r-cran-sjmisc r-cran-sjstats \
  r-cran-ggeffects r-cran-ggally r-cran-ggthemes r-cran-viridis r-cran-mice r-cran-hmisc \
  r-cran-ggalluvial r-cran-dendextend r-cran-rio \
  r-cran-pwr r-cran-coin r-cran-multcomp r-cran-lmertest r-cran-ordinal r-cran-pscl \
  r-cran-polycor r-cran-vcd r-cran-semplot r-cran-erm r-cran-qgraph \
  r-cran-epitools r-cran-epir r-cran-metafor r-cran-survminer r-cran-proc r-cran-survey \
  r-cran-plm r-cran-aer r-cran-lmtest r-cran-sandwich r-cran-forecast r-cran-tseries \
  r-cran-urca r-cran-zoo r-cran-xts \
  r-cran-vegan r-cran-ade4 \
  r-cran-factominer r-cran-factoextra r-cran-randomforest r-cran-glmnet r-cran-e1071 r-cran-caret \
  r-cran-tidytext r-cran-tm r-cran-wordcloud r-cran-snowballc
# A propósito NO: devtools y remotes (instalar desde GitHub es lo que la jaula
# impide), quarto y rmarkdown (la tesis la redacta Claude y el Word lo arma el
# backend), quantmod (descarga datos de internet y la jaula no tiene red), y sf
# y terra (mapas de varios archivos y rásteres que no caben en 400 MB).
Rscript --version

echo "── Usuario de la jaula ──"
if ! id acosta-r >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin acosta-r
fi
usermod -aG acosta-r acosta
id acosta

echo "── Carpeta de las sesiones ──"
install -d -o root -g acosta-r -m 0750 /var/lib/acostaresearch-r
install -d -o acosta -g acosta-r -m 2770 "$SESIONES"
ls -ld /var/lib/acostaresearch-r "$SESIONES"

echo "── Unidad, slice y polkit ──"
install -m 0644 "$ORIGEN/acostaresearch-r@.service" /etc/systemd/system/
install -m 0644 "$ORIGEN/acostaresearch-r.slice" /etc/systemd/system/
install -d -m 0755 /etc/polkit-1/rules.d
install -m 0644 "$ORIGEN/60-acostaresearch-r.rules" /etc/polkit-1/rules.d/
# La unidad de la API lleva ProtectSystem=strict y solo escribe en
# /var/lib/acostaresearch: sin este añadido, la carpeta de sesiones le queda en
# solo lectura aunque esté en el grupo, y la herramienta diría «no disponible».
install -d -m 0755 /etc/systemd/system/acostaresearch.service.d
cat > /etc/systemd/system/acostaresearch.service.d/r-sesiones.conf <<'CONF'
# La API deja el código de R y lee lo que devuelve en esta carpeta.
# Sin esto, ProtectSystem=strict de la unidad la deja en solo lectura.
# Lo instala infra/r/instalar.sh.
[Service]
ReadWritePaths=/var/lib/acostaresearch-r/sesiones
CONF

systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/acostaresearch-r@.service 2>&1 | grep -v "^$" || true

echo "── Swap ──"
if swapon --show | grep -q .; then
  echo "   ya hay swap"
else
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q "^/swapfile " /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
  echo "   2 GB de swap activos"
fi
free -m

echo "── Reiniciando la API para que coja el grupo ──"
systemctl restart acostaresearch
sleep 5
systemctl is-active --quiet acostaresearch && echo "   servicio activo" || {
  echo "   FALLÓ. Últimas líneas:"
  journalctl -u acostaresearch -n 20 --no-pager -o cat
  exit 1
}

echo
echo "Instalado. Ahora: bash $ORIGEN/probar-jaula.sh"

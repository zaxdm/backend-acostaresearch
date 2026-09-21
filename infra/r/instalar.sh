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

echo "── R, de CRAN y compilado (r2u) ──"
# r2u: todo CRAN como paquetes de Ubuntu ya compilados, con R 4.6. Ubuntu solo
# traía unos pocos paquetes de R y en R 4.3.3, y el servidor no tiene compilador
# (ni debe tenerlo). Son los pasos 1-4 del script oficial para noble
# (github.com/eddelbuettel/r2u, inst/scripts/add_cranapt_noble.sh). El paso 5,
# bspm, NO: conecta install.packages() con apt, e install.packages() está
# bloqueado a propósito en la jaula.
export DEBIAN_FRONTEND=noninteractive
APT="apt-get -o DPkg::Lock::Timeout=300 -qq"
$APT update
$APT install -y --no-install-recommends ca-certificates gnupg
if [ ! -s /usr/share/keyrings/r2u.gpg ]; then
  gpg --homedir /tmp --no-default-keyring --keyring /usr/share/keyrings/r2u.gpg \
    --keyserver keyserver.ubuntu.com --recv-keys A1489FE2AB99A21A 67C2D66C4B1D4339 51716619E084DAB9
fi
cat > /etc/apt/sources.list.d/r2u.sources <<'FUENTE'
Types: deb
URIs: https://r2u.stat.illinois.edu/ubuntu
Suites: noble
Components: main
Architectures: amd64 arm64
Signed-By: /usr/share/keyrings/r2u.gpg
FUENTE
cat > /etc/apt/sources.list.d/cran.sources <<'FUENTE'
Types: deb
URIs: https://cloud.r-project.org/bin/linux/ubuntu
Suites: noble-cran40/
Components:
Architectures: amd64 arm64
Signed-By: /usr/share/keyrings/r2u.gpg
FUENTE
cat > /etc/apt/preferences.d/99cranapt <<'FIJAR'
Package: *
Pin: release o=CRAN-Apt Project
Pin: release l=CRAN-Apt Packages
Pin-Priority: 700
FIJAR
$APT update

# Lo que ya hubiera de Ubuntu, a su versión de r2u: un paquete compilado para
# R 4.3 dentro de R 4.6 es un fallo esperando a pasar.
INSTALADOS=$(dpkg-query -W -f='${db:Status-Abbrev} ${Package}\n' 'r-cran-*' 2>/dev/null | awk '/^ii/ {print $2}')
# shellcheck disable=SC2086
[ -n "$INSTALADOS" ] && $APT install -y --no-install-recommends --only-upgrade $INSTALADOS

# Los que usan las tesis. Si se añade uno, va también al filtro (r.filtro.js),
# a la descripción de trabajar_en_r y a probar-jaula.sh.
$APT install -y --no-install-recommends \
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
  r-cran-polycor r-cran-vcd r-cran-erm r-cran-qgraph r-cran-semplot \
  r-cran-epitools r-cran-epir r-cran-metafor r-cran-survminer r-cran-proc r-cran-survey \
  r-cran-plm r-cran-aer r-cran-lmtest r-cran-sandwich r-cran-forecast r-cran-tseries \
  r-cran-urca r-cran-zoo r-cran-xts \
  r-cran-vegan r-cran-ade4 \
  r-cran-factominer r-cran-factoextra r-cran-randomforest r-cran-glmnet r-cran-e1071 r-cran-caret \
  r-cran-tidytext r-cran-tm r-cran-wordcloud r-cran-snowballc \
  r-cran-nfactors r-cran-paran r-cran-mirt r-cran-ltm r-cran-difr r-cran-irr r-cran-mvn \
  r-cran-seminr r-cran-plspm r-cran-csem \
  r-cran-moments r-cran-desctools r-cran-bayesfactor \
  r-cran-gtsummary r-cran-apatables r-cran-janitor r-cran-meta \
  r-cran-fixest r-cran-panelr r-cran-pdynmc \
  r-cran-agricolae \
  r-cran-sf r-cran-terra \
  r-cran-quanteda r-cran-quanteda.textstats r-cran-quanteda.textplots r-cran-topicmodels \
  r-cran-bibliometrix r-cran-igraph
# bibliometrix arrastra shiny, plotly y visNetwork (su biblioshiny): se instalan
# pero no sirven aquí, porque la jaula no tiene red ni proceso vivo que sirva una
# web. Se usa por funciones, desde la conversación.
# A propósito NO: devtools y remotes (instalar desde GitHub es lo que la jaula
# impide), quarto y rmarkdown (la tesis la redacta Claude y el Word lo arma el
# backend), quantmod y leaflet (descargan de internet y la jaula no tiene red),
# tmap y FielDHub (mapas y aplicaciones interactivas), y brms, rstanarm y
# blavaan (Stan compila cada modelo al vuelo y aquí no hay compilador).
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
# La jaula del mapeo bibliométrico: la MISMA unidad con otro nombre y más
# memoria. Copiada y no escrita aparte, para que no se aparten con el tiempo: lo
# único que cambia es el añadido de memoria. La elige el backend cuando la
# sesión tiene un exporte de Scopus o WoS (ver r.motor, esBibliografica).
install -m 0644 "$ORIGEN/acostaresearch-r@.service" /etc/systemd/system/acostaresearch-r-biblio@.service
install -d -m 0755 /etc/systemd/system/acostaresearch-r-biblio@.service.d
install -m 0644 "$ORIGEN/biblio-memoria.conf" /etc/systemd/system/acostaresearch-r-biblio@.service.d/memoria.conf
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

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
apt-get install -y -qq --no-install-recommends r-base-core r-recommended r-cran-readxl
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

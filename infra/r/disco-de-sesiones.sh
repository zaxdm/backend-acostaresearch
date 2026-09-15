#!/usr/bin/env bash
#
# Pone las sesiones de R en un disco propio, con techo. Se puede repetir.
#
# Uso (como root):
#
#   bash /opt/acostaresearch/app/infra/r/disco-de-sesiones.sh [tamaño]   # 4G por defecto
#
# POR QUÉ
# -------
# La jaula limita cada archivo a 50 MB, pero no cuántos: en 45 segundos, un
# bucle de R escribía varios GB en su sesión, y la sesión estaba en el disco
# raíz, donde viven la API, el registro y el respaldo de las 3:30. Llenarlo
# tumbaba todo. En una imagen propia, lo peor que pasa al llenarla es que R se
# queda sin espacio; el resto del servidor ni se entera.
#
# Se monta con noexec: lo que R escribe en su sesión no se puede ejecutar.
#
# Qué hace: crea la imagen, copia las sesiones que haya con sus permisos, la
# monta en su sitio, la deja en /etc/fstab y reinicia la API para que vea el
# montaje nuevo. La carpeta de antes queda como `sesiones.antes-del-disco`:
# se borra a mano cuando se haya comprobado que todo va.
set -euo pipefail

SESIONES=/var/lib/acostaresearch-r/sesiones
IMAGEN=/var/lib/acostaresearch-r.img
TAMANO="${1:-4G}"
OPCIONES=loop,nodev,nosuid,noexec

[ "$(id -u)" = "0" ] || { echo "Hay que ejecutarlo como root."; exit 1; }
[ -d "$SESIONES" ] || { echo "No existe $SESIONES: primero infra/r/instalar.sh."; exit 1; }

if mountpoint -q "$SESIONES"; then
  echo "Las sesiones ya tienen su disco:"
  df -h "$SESIONES"
  exit 0
fi

if [ -e "$IMAGEN" ]; then
  echo "Ya existe $IMAGEN pero no está montada. Revísalo a mano antes de seguir."
  exit 1
fi

if systemctl list-units --state=active --no-legend 'acostaresearch-r@*' | grep -q .; then
  echo "Hay un R corriendo ahora mismo. Espera unos segundos y vuelve a lanzarlo."
  exit 1
fi

echo "── Imagen de $TAMANO ──"
fallocate -l "$TAMANO" "$IMAGEN"
chmod 600 "$IMAGEN"
mkfs.ext4 -q -F -m 0 -L acosta-r "$IMAGEN"

echo "── Copiando las sesiones ──"
TEMPORAL="$(mktemp -d)"
mount -o "$OPCIONES" "$IMAGEN" "$TEMPORAL"
cp -a "$SESIONES/." "$TEMPORAL/"
rm -rf "$TEMPORAL/lost+found"
chown acosta:acosta-r "$TEMPORAL"
chmod 2770 "$TEMPORAL"
umount "$TEMPORAL"
rmdir "$TEMPORAL"

echo "── Montando en su sitio ──"
mv "$SESIONES" "$SESIONES.antes-del-disco"
install -d -o acosta -g acosta-r -m 2770 "$SESIONES"
grep -q "^$IMAGEN " /etc/fstab || echo "$IMAGEN $SESIONES ext4 $OPCIONES 0 2" >> /etc/fstab
systemctl daemon-reload
mount "$SESIONES"
df -h "$SESIONES"
ls -ld "$SESIONES"

echo "── Reiniciando la API para que vea el disco nuevo ──"
systemctl restart acostaresearch
sleep 5
systemctl is-active --quiet acostaresearch && echo "   servicio activo" || {
  echo "   FALLÓ. Últimas líneas:"
  journalctl -u acostaresearch -n 20 --no-pager -o cat
  exit 1
}

echo
echo "Hecho. Comprueba con: bash /opt/acostaresearch/app/infra/r/probar-jaula.sh"
echo "Y cuando todo vaya: rm -rf $SESIONES.antes-del-disco"

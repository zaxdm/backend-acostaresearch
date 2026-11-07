#!/usr/bin/env bash
#
# Sube a la Storage Box de Hetzner, cifrado con restic, el respaldo que acaba de
# dejar respaldar.sh.
#
# POR QUÉ: la base vive en el mismo disco que sus respaldos. Si Hetzner pierde
# la máquina, se pierde todo. Hasta el 7-nov-2026 la copia de fuera iba a
# Google Drive (subir-respaldo.sh), pero Drive se llenó el 24-oct y dejó de
# subir. Desde el 7-nov va a una Storage Box de 1 TB:
#   «acosta-respaldo», BX11 #694528, usuario u712728, en Helsinki (el VPS está
#   en Núremberg: un problema en un centro de datos no se lleva las dos cosas).
#
# CÓMO:
#   · se entra por SSH (puerto 23) con una llave solo para esto,
#     /root/.ssh/storagebox_ed25519, con el alias «caja-respaldo» de
#     /root/.ssh/config. En la caja también está la llave del PC del
#     administrador, por si hay que entrar a mano;
#   · restic cifra todo (AES-256) con la MISMA frase que usaba Drive
#     (/root/.config/acostaresearch/clave-respaldo, y en el gestor de
#     contraseñas del administrador). Sin la frase, el respaldo no se abre;
#   · se sube el contenido del .tar.gz ya desempaquetado y la base sin
#     comprimir: así restic solo manda lo que cambió desde ayer, en vez de los
#     ~600 MB enteros cada día;
#   · se guardan 14 diarios y 6 mensuales;
#   · el día 1 (o con PROBAR=1) se lee de vuelta una parte de los datos, se
#     restaura la base y se cuentan sus tablas. Llega un aviso con el resultado.
#
# Cualquier fallo sale con código distinto de 0, y systemd avisa al móvil
# (acostaresearch-aviso@.service).
#
# Restaurar a mano:
#   export RESTIC_REPOSITORY=sftp:caja-respaldo:/home/restic \
#          RESTIC_PASSWORD_FILE=/root/.config/acostaresearch/clave-respaldo
#   restic snapshots
#   restic restore latest --target /tmp/restaurado
set -euo pipefail

ORIGEN=${ORIGEN:-/var/backups/acostaresearch}
CLAVE=/root/.config/acostaresearch/clave-respaldo
# Carpeta fija: restic reconoce que es la misma de ayer y compara más rápido.
PREPARADO=/var/backups/acostaresearch-caja
export RESTIC_REPOSITORY=${RESTIC_REPOSITORY:-sftp:caja-respaldo:/home/restic}
export RESTIC_PASSWORD_FILE=$CLAVE
HOST=acostaresearch

[ -r "$CLAVE" ] || { echo "ERROR: falta la frase de cifrado en $CLAVE" >&2; exit 1; }
command -v restic >/dev/null || { echo "ERROR: restic no está instalado" >&2; exit 1; }

ULTIMO=$(ls -1t "$ORIGEN"/acostaresearch-*.tar.gz 2>/dev/null | head -1 || true)
[ -n "$ULTIMO" ] || { echo "ERROR: no hay ningún respaldo en $ORIGEN" >&2; exit 1; }

# Un respaldo de ayer subido como si fuera de hoy engaña: tiene que ser reciente.
if [ -n "$(find "$ULTIMO" -mmin +360)" ]; then
  echo "ERROR: el último respaldo ($(basename "$ULTIMO")) tiene más de 6 horas" >&2
  exit 1
fi

# Lleva la base entera y el .env: solo root, y se borra pase lo que pase.
TRABAJO=$(mktemp -d)
trap 'rm -rf "$PREPARADO" "$TRABAJO"' EXIT
umask 077
rm -rf "$PREPARADO"
mkdir -p "$PREPARADO"
chmod 700 "$PREPARADO" "$TRABAJO"

tar -xzf "$ULTIMO" -C "$PREPARADO"
gunzip "$PREPARADO/base-de-datos.sql.gz"
[ -s "$PREPARADO/base-de-datos.sql" ] || { echo "ERROR: el respaldo no trae la base de datos" >&2; exit 1; }

restic backup --host "$HOST" --tag diario "$PREPARADO"

# Rotación: solo después de haber subido bien el de hoy.
restic forget --host "$HOST" --keep-daily 14 --keep-monthly 6 --prune

# Comprobación rápida de la estructura cada día (no baja los datos).
restic check

echo "$(date +'%F %T')  subido a la caja  $(basename "$ULTIMO")"

# ── Prueba de restauración, una vez al mes (o con PROBAR=1) ────────────────
if [ "$(date +%d)" = "01" ] || [ "${PROBAR:-0}" = "1" ]; then
  # Lee de verdad una décima parte de lo guardado, para notar si algo se dañó.
  restic check --read-data-subset=10%
  restic restore latest --host "$HOST" --target "$TRABAJO/prueba" \
    --include "$PREPARADO/base-de-datos.sql"
  RESTAURADO="$TRABAJO/prueba$PREPARADO/base-de-datos.sql"
  TABLAS=$(grep -c '^CREATE TABLE' "$RESTAURADO" || true)
  if [ "$TABLAS" -lt 10 ]; then
    echo "ERROR: la base restaurada de la caja trae solo $TABLAS tablas" >&2
    exit 1
  fi
  /opt/acostaresearch/avisar.sh "Respaldo comprobado" \
    "Se restauró de la Storage Box el de hoy y la base trae $TABLAS tablas. Restaurar funciona." 3
  echo "$(date +'%F %T')  prueba de restauración ok  ($TABLAS tablas)"
fi

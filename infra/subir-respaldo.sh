#!/usr/bin/env bash
#
# Sube a Google Drive, cifrado, el respaldo que acaba de dejar respaldar.sh.
#
# POR QUÉ: desde la mudanza a MySQL local (19-sep-2026) la base vive en el
# mismo disco que sus respaldos. Si Hetzner pierde la máquina, se pierde todo.
# Esto deja una copia fuera cada día.
#
# CÓMO:
#   · se cifra con gpg (AES-256) y una frase que vive SOLO en el servidor
#     (/root/.config/acostaresearch/clave-respaldo) y en el gestor de
#     contraseñas del administrador. Drive nunca ve nada legible: dentro van la
#     base entera y el .env con todos los secretos. Sin la frase, el respaldo
#     no sirve para nada, ni a un atacante ni a nosotros;
#   · rclone lo sube a la carpeta AcostaResearch-respaldos de su Drive, con un
#     permiso que solo ve los archivos que crea él (drive.file);
#   · se guardan los 14 últimos diarios y, el día 1 de cada mes, una copia
#     mensual que se guarda 6 meses (unos 2,5 GB en total);
#   · el día 1 también se BAJA el mensual, se descifra y se comprueba que la
#     base está dentro y se descomprime: un respaldo que nadie ha restaurado no
#     es un respaldo. Llega un aviso con el resultado.
#
# Cualquier fallo sale con código distinto de 0, y systemd avisa al móvil
# (acostaresearch-aviso@.service).
set -euo pipefail

ORIGEN=${ORIGEN:-/var/backups/acostaresearch}
CLAVE=/root/.config/acostaresearch/clave-respaldo
REMOTO=${REMOTO:-respaldo-drive:AcostaResearch-respaldos}
DIAS_DIARIOS=14
DIAS_MENSUALES=190

[ -r "$CLAVE" ] || { echo "ERROR: falta la frase de cifrado en $CLAVE" >&2; exit 1; }
command -v rclone >/dev/null || { echo "ERROR: rclone no está instalado" >&2; exit 1; }

ULTIMO=$(ls -1t "$ORIGEN"/acostaresearch-*.tar.gz 2>/dev/null | head -1 || true)
[ -n "$ULTIMO" ] || { echo "ERROR: no hay ningún respaldo en $ORIGEN" >&2; exit 1; }

# Un respaldo de ayer subido como si fuera de hoy engaña: tiene que ser reciente.
if [ -n "$(find "$ULTIMO" -mmin +360)" ]; then
  echo "ERROR: el último respaldo ($(basename "$ULTIMO")) tiene más de 6 horas" >&2
  exit 1
fi

TRABAJO=$(mktemp -d)
trap 'rm -rf "$TRABAJO"' EXIT
chmod 700 "$TRABAJO"
CIFRADO="$TRABAJO/$(basename "$ULTIMO").gpg"

gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$CLAVE" \
  --symmetric --cipher-algo AES256 --compress-algo none \
  --output "$CIFRADO" "$ULTIMO"

rclone copyto "$CIFRADO" "$REMOTO/diarios/$(basename "$CIFRADO")" --retries 3 --low-level-retries 5

# Se comprueba que lo que quedó en Drive mide lo mismo que lo que se subió.
LOCAL=$(stat -c %s "$CIFRADO")
REMOTO_BYTES=$(rclone size --json "$REMOTO/diarios/$(basename "$CIFRADO")" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')
if [ "$LOCAL" != "$REMOTO_BYTES" ]; then
  echo "ERROR: en Drive mide $REMOTO_BYTES bytes y aquí $LOCAL" >&2
  exit 1
fi

if [ "$(date +%d)" = "01" ]; then
  rclone copyto "$REMOTO/diarios/$(basename "$CIFRADO")" "$REMOTO/mensuales/$(basename "$CIFRADO")"
fi

# Rotación: solo después de haber subido bien el de hoy.
rclone delete "$REMOTO/diarios" --min-age "${DIAS_DIARIOS}d" --include 'acostaresearch-*.gpg'
rclone delete "$REMOTO/mensuales" --min-age "${DIAS_MENSUALES}d" --include 'acostaresearch-*.gpg'

echo "$(date +'%F %T')  subido  $(basename "$CIFRADO")  $(du -h "$CIFRADO" | cut -f1)"

# ── Prueba de restauración, una vez al mes (o con PROBAR=1) ────────────────
if [ "$(date +%d)" = "01" ] || [ "${PROBAR:-0}" = "1" ]; then
  PRUEBA="$TRABAJO/prueba"
  mkdir -p "$PRUEBA"
  rclone copyto "$REMOTO/diarios/$(basename "$CIFRADO")" "$PRUEBA/bajado.gpg"
  gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$CLAVE" \
    --decrypt --output "$PRUEBA/respaldo.tar.gz" "$PRUEBA/bajado.gpg"
  tar -xzf "$PRUEBA/respaldo.tar.gz" -C "$PRUEBA" base-de-datos.sql.gz
  TABLAS=$(gunzip -c "$PRUEBA/base-de-datos.sql.gz" | grep -c '^CREATE TABLE' || true)
  if [ "$TABLAS" -lt 10 ]; then
    echo "ERROR: el respaldo bajado de Drive trae solo $TABLAS tablas" >&2
    exit 1
  fi
  /opt/acostaresearch/avisar.sh "Respaldo comprobado" \
    "Se bajó de Drive el de hoy, se descifró y la base trae $TABLAS tablas. Restaurar funciona." 3
  echo "$(date +'%F %T')  prueba de restauración ok  ($TABLAS tablas)"
fi

#!/usr/bin/env bash
#
# Respaldo diario de todo lo que no se puede reconstruir.
#
# Qué se guarda y por qué:
#
#   · la base de datos completa              cuentas, licencias, pagos, el corpus
#                                            y las fuentes que ha subido cada
#                                            comprador. Nada de esto está en
#                                            GitHub ni se puede rehacer.
#   · /var/lib/acostaresearch/skills         los 31 bundles. Son el producto.
#   · /var/lib/acostaresearch/comprobantes   las capturas de Yape. Son la prueba
#                                            de un cobro: si un comprador
#                                            reclama, esto es lo que hay que
#                                            enseñar.
#   · /opt/acostaresearch/app/.env           los secretos. Sin él hay que
#                                            reconstruir claves y credenciales a
#                                            mano, y rotar las sesiones de todos.
#
# SOBRE LA BASE DE DATOS
# ----------------------
# Antes este script la dejaba fuera, con el argumento de que "vive en Clever
# Cloud y la respalda ellos". Eso es cierto en los planes de pago; el nuestro es
# el plan Dev, que NO incluye copia de seguridad. Durante meses el único sitio
# donde existían las licencias y las fuentes de los compradores fue un servidor
# compartido sin respaldo.
#
# El volcado sale por la red y ocupa una de las cinco conexiones que da el plan.
# Por eso va con --single-transaction (no bloquea nada) y a las 3:30, cuando no
# hay nadie. Nunca debe coincidir con una sincronización de Zotero.
set -euo pipefail

DESTINO=${DESTINO:-/var/backups/acostaresearch}
ENV_APP=/opt/acostaresearch/app/.env
FECHA=$(date +%F)
ARCHIVO="$DESTINO/acostaresearch-$FECHA.tar.gz"
DIAS=14

mkdir -p "$DESTINO"
chmod 700 "$DESTINO"

TRABAJO=$(mktemp -d)
CNF="$TRABAJO/cliente.cnf"
VOLCADO="$TRABAJO/base-de-datos.sql"
# El temporal lleva la contraseña y el volcado entero: se borra pase lo que pase.
trap 'rm -rf "$TRABAJO"' EXIT
chmod 700 "$TRABAJO"

# ── Credenciales ───────────────────────────────────────────────────────────
# Se leen del .env y no se imprimen nunca, ni siquiera en un error. Tampoco
# viajan por la línea de órdenes: irían en `ps` a la vista de cualquiera.

URL=$(grep -m1 '^DATABASE_URL=' "$ENV_APP" | cut -d= -f2-)
URL=${URL%\"}; URL=${URL#\"}
URL=${URL%\'}; URL=${URL#\'}

if [ -z "$URL" ]; then
  echo "ERROR: no encuentro DATABASE_URL en $ENV_APP" >&2
  exit 1
fi

resto=${URL#mysql://}
# Se corta por la ÚLTIMA arroba: una contraseña puede contener arrobas, un host no.
credenciales=${resto%@*}
servidor=${resto##*@}

DB_USER=${credenciales%%:*}
DB_PASS=${credenciales#*:}
# La URL viene con los caracteres raros escapados; hay que devolverlos.
DB_PASS=$(printf '%b' "${DB_PASS//%/\\x}")

hostpuerto=${servidor%%/*}
DB_HOST=${hostpuerto%%:*}
DB_PORT=${hostpuerto#*:}
[ "$DB_PORT" = "$DB_HOST" ] && DB_PORT=3306

DB_NAME=${servidor#*/}
DB_NAME=${DB_NAME%%\?*}

umask 077
printf '[client]\nuser=%s\npassword="%s"\nhost=%s\nport=%s\n' \
  "$DB_USER" "$DB_PASS" "$DB_HOST" "$DB_PORT" > "$CNF"

# ── Volcado ────────────────────────────────────────────────────────────────
# --single-transaction  lee una foto coherente sin bloquear a nadie.
# --no-tablespaces      el usuario de un plan compartido no tiene PROCESS.
# --set-gtid-purged=OFF ni tiene SUPER, y sin esto el volcado no se puede cargar.

if ! mysqldump --defaults-extra-file="$CNF" \
      --single-transaction --quick \
      --no-tablespaces --set-gtid-purged=OFF --column-statistics=0 \
      --routines --triggers \
      "$DB_NAME" > "$VOLCADO" 2> "$TRABAJO/error.txt"; then
  echo "ERROR: falló el volcado de la base de datos" >&2
  sed 's/password=.*/password=OCULTA/' "$TRABAJO/error.txt" >&2
  echo "No se rota nada: los respaldos viejos se quedan donde están." >&2
  exit 1
fi

# mysqldump puede salir con éxito y dejar un archivo truncado si se corta la
# conexión a mitad. La última línea del volcado es la única prueba de que llegó
# hasta el final.
if ! tail -c 200 "$VOLCADO" | grep -q 'Dump completed'; then
  echo "ERROR: el volcado quedó a medias, no se rota nada" >&2
  exit 1
fi

FILAS=$(grep -c '^INSERT INTO' "$VOLCADO" || true)
TABLAS=$(grep -c '^CREATE TABLE' "$VOLCADO" || true)

if [ "$TABLAS" -lt 10 ]; then
  echo "ERROR: solo $TABLAS tablas en el volcado; se esperaban más de 20" >&2
  exit 1
fi

gzip -9 "$VOLCADO"

# ── Empaquetado ────────────────────────────────────────────────────────────

tar -czf "$ARCHIVO" \
  -C /var/lib acostaresearch \
  -C /opt/acostaresearch/app .env \
  -C "$TRABAJO" base-de-datos.sql.gz 2>/dev/null

# Contiene secretos y la base entera: solo root puede leerlo.
chmod 600 "$ARCHIVO"

# Se comprueba que el archivo es legible ANTES de borrar los viejos. Un respaldo
# corrupto que ha ido desplazando a los buenos es peor que no tener ninguno.
if ! tar -tzf "$ARCHIVO" > /dev/null 2>&1; then
  echo "ERROR: el respaldo salió corrupto, no se rota nada" >&2
  rm -f "$ARCHIVO"
  exit 1
fi

# Y que la base de datos está dentro de verdad, no solo que el tar se abre.
if ! tar -tzf "$ARCHIVO" | grep -q 'base-de-datos.sql.gz'; then
  echo "ERROR: el respaldo no lleva la base de datos, no se rota nada" >&2
  rm -f "$ARCHIVO"
  exit 1
fi

find "$DESTINO" -name 'acostaresearch-*.tar.gz' -mtime +$DIAS -delete

echo "$(date +'%F %T')  ok  $(basename "$ARCHIVO")  $(du -h "$ARCHIVO" | cut -f1)  ($TABLAS tablas, $FILAS inserciones)"

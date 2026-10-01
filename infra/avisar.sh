#!/usr/bin/env bash
#
# Un aviso al móvil por ntfy desde los scripts del servidor (el backend usa
# lib/notify). Lee el tópico del .env de la app sin imprimirlo.
#
# Todo lo de aquí es técnico (respaldos, tareas que fallan), así que va al
# tópico del programador, NTFY_TOPIC_PROGRAMADOR. Si no está, al de siempre.
#
#   avisar.sh "título" "mensaje" [prioridad 1-5]
#
# También lo usa systemd cuando falla un servicio programado:
#   acostaresearch-aviso@<servicio>.service  →  avisar.sh "Falló <servicio>" …
set -uo pipefail

ENV_APP=/opt/acostaresearch/app/.env
TITULO=${1:-Aviso del servidor}
MENSAJE=${2:-}
PRIORIDAD=${3:-4}

leer() { grep -m1 "^$1=" "$ENV_APP" 2>/dev/null | cut -d= -f2- | tr -d "\"'\r"; }
TOPICO=$(leer NTFY_TOPIC_PROGRAMADOR)
[ -n "$TOPICO" ] || TOPICO=$(leer NTFY_TOPIC)
URL=$(leer NTFY_URL)
URL=${URL:-https://ntfy.sh}
[ -n "$TOPICO" ] || { echo "ntfy sin configurar: $TITULO — $MENSAJE" >&2; exit 0; }

# JSON armado con python3 para que las comillas o tildes del mensaje no lo rompan.
CUERPO=$(TOPICO="$TOPICO" TITULO="$TITULO" MENSAJE="$MENSAJE" PRIORIDAD="$PRIORIDAD" python3 -c '
import json, os
print(json.dumps({"topic": os.environ["TOPICO"], "title": os.environ["TITULO"],
  "message": os.environ["MENSAJE"], "priority": int(os.environ["PRIORIDAD"]), "tags": ["floppy_disk"]}))')

curl -fsS -m 10 -H 'Content-Type: application/json' -d "$CUERPO" "$URL" >/dev/null \
  || echo "no se pudo avisar por ntfy: $TITULO" >&2

#!/usr/bin/env bash
#
# Vigía del disco: avisa al móvil (tópico del programador) cuando el disco
# del servidor se está llenando. Lo lanza acostaresearch-vigia-disco.timer
# cada 10 minutos.
#
# Puesto el 16-nov-2026: el disco llegó al 100 % sin que nada avisara (13 GB
# de syslog de un ataque + 14 respaldos locales) y la plataforma se cayó.
#
#   ≥ 85 %  aviso prioridad 4, se repite cada hora mientras siga así
#   ≥ 90 %  prioridad 5, cada hora
#   ≥ 95 %  prioridad 5, cada 10 minutos
#   vuelve por debajo del 80 % después de un aviso → «Disco con espacio otra vez»
#
# El estado vive en /run (se limpia al reiniciar: después de un reinicio con
# el disco lleno se vuelve a avisar enseguida, que es lo que queremos).
set -uo pipefail

AVISAR=/opt/acostaresearch/avisar.sh
ESTADO=/run/acostaresearch-vigia-disco
UMBRAL=${UMBRAL:-85}

USO=$(df --output=pcent / | tail -1 | tr -dc '0-9')
LIBRE=$(df -h --output=avail / | tail -1 | tr -d ' ')
AHORA=$(date +%s)
ULTIMO=$(cat "$ESTADO" 2>/dev/null || echo 0)

if [ "$USO" -lt "$UMBRAL" ]; then
  if [ "$ULTIMO" != 0 ] && [ "$USO" -lt 80 ]; then
    "$AVISAR" "Disco con espacio otra vez" "El disco está al ${USO} % (${LIBRE} libres)." 3
    rm -f "$ESTADO"
  fi
  exit 0
fi

if   [ "$USO" -ge 95 ]; then PRIORIDAD=5; CADA=600
elif [ "$USO" -ge 90 ]; then PRIORIDAD=5; CADA=3600
else                         PRIORIDAD=4; CADA=3600
fi

[ $((AHORA - ULTIMO)) -ge "$CADA" ] || exit 0

# Lo que más ocupa, para saber por dónde empezar sin entrar al servidor.
GRANDES=$(du -xsh /var/log /var/backups /var/lib/mysql /opt /root /tmp 2>/dev/null \
  | sort -rh | head -4 | awk '{printf "%s %s · ", $1, $2}')

"$AVISAR" "Disco al ${USO} %" \
  "Quedan ${LIBRE}. Con el disco lleno se cae la base de datos y la web. Lo que más ocupa: ${GRANDES% · }. Mira: df -h / ; ls -laSh /var/log | head" \
  "$PRIORIDAD"
echo "$AHORA" > "$ESTADO"

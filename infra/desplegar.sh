#!/usr/bin/env bash
#
# Despliega la versión que haya en main.
#
# Uso:  ssh acosta /opt/acostaresearch/desplegar.sh
#
# El .env NO se toca: vive fuera del control de versiones y sobrevive a cada
# despliegue. Las carpetas de skills y comprobantes tampoco: están en
# /var/lib/acostaresearch, fuera del directorio del código, justo para que un
# despliegue no pueda llevárselas por delante.
set -euo pipefail

APP=/opt/acostaresearch/app
cd "$APP"

echo "── Trayendo cambios ──"
sudo -u acosta git fetch -q origin main
ANTES=$(git rev-parse --short HEAD)
sudo -u acosta git reset -q --hard origin/main
AHORA=$(git rev-parse --short HEAD)
echo "   $ANTES → $AHORA"

echo "── Dependencias ──"
sudo -u acosta npm ci --omit=dev --no-audit --no-fund --silent

echo "── Migraciones ──"
# `migrate deploy` solo aplica lo pendiente y nunca borra datos, al contrario
# que `migrate dev`, que en producción no debe usarse jamás.
sudo -u acosta npx prisma migrate deploy

echo "── Reiniciando ──"
systemctl restart acostaresearch
sleep 5

if systemctl is-active --quiet acostaresearch; then
  echo "   servicio activo"
else
  echo "   FALLÓ. Últimas líneas:"
  journalctl -u acostaresearch -n 20 --no-pager -o cat
  exit 1
fi

echo "── Comprobación desde fuera ──"
CODIGO=$(curl -s -o /dev/null -w '%{http_code}' https://api.acostaresearch.com/api/v1/billing/plans)
echo "   /billing/plans → $CODIGO"
[ "$CODIGO" = "200" ] || { echo "   la API no responde bien"; exit 1; }

echo
echo "Desplegado."

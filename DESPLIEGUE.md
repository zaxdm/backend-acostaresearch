# Despliegue

Cómo está montado esto y cómo se publican cambios.

## El mapa

```
                    ┌─────────────────────────────────────────┐
   acostaresearch.com │  Cloudflare Workers                     │
   www.acostaresearch │  La web (Angular) + un Worker que hace  │
        │             │  de proxy de /api/* y resuelve las      │
        │             │  rutas del router                       │
        │             └────────────────┬────────────────────────┘
        │                              │  /api/*
        │                              ▼
        │             ┌─────────────────────────────────────────┐
api.acostaresearch.com│  Hetzner · Núremberg · 2.28.64.216      │
        └────────────▶│  Caddy → Node (systemd) en localhost:3000│
                      └────────────────┬────────────────────────┘
                                       │
                                       ▼
                      ┌─────────────────────────────────────────┐
                      │  Clever Cloud · París · MySQL           │
                      └─────────────────────────────────────────┘
```

El conector MCP que los compradores pegan en Claude entra por
`api.acostaresearch.com/mcp/<token>`, directo al backend sin pasar por la web.

---

## Publicar cambios

**Backend:**

```bash
cd backend
npm run deploy        # git push && ssh acosta /opt/acostaresearch/desplegar.sh
```

El script trae `main`, instala dependencias, aplica migraciones pendientes,
reinicia el servicio y comprueba desde fuera que la API responde. Si algo falla,
aborta y enseña las últimas líneas del log.

**Frontend:**

```bash
cd acostaresearch-frontend
git push              # Cloudflare compila y publica solo
```

Cloudflare vigila el repositorio `acostaresearch/frontend-acostaresearch` y
construye en cada push a `main`. Para publicar sin pasar por GitHub:

```bash
npm run deploy        # npm run build && wrangler deploy
```

---

## El servidor

| | |
|---|---|
| Acceso | `ssh acosta` (alias en `~/.ssh/config`, **puerto 2222**) |
| Código | `/opt/acostaresearch/app` |
| Servicio | `acostaresearch.service`, corre como el usuario `acosta` |
| Puerto | 3000, **solo en localhost**: el proceso de Node no está expuesto |
| Proxy | Caddy (`/etc/caddy/Caddyfile`), certificados automáticos |
| Node | v22 |

El puerto 2222 y no el 22 porque la red desde la que se administra bloquea el 22
de salida. El servidor escucha en los dos.

### Las carpetas que no se pueden perder

```
/var/lib/acostaresearch/skills         los .skill que sirve el conector
/var/lib/acostaresearch/comprobantes   las capturas de los pagos por Yape
/var/lib/acostaresearch/guias          la guía de instalación en PDF
```

Viven **fuera** del directorio del código a propósito: `desplegar.sh` hace
`git reset --hard`, y si estuvieran dentro se las llevaría por delante. Los
comprobantes son la prueba de un cobro y hay que poder releerlos meses después.

### El `.env` de producción

Está en `/opt/acostaresearch/app/.env`, **fuera del control de versiones**, y
sobrevive a cada despliegue. Para cambiar una variable hay que editarlo por SSH y
reiniciar:

```bash
ssh acosta
nano /opt/acostaresearch/app/.env
systemctl restart acostaresearch
```

Lo que difiere del `.env` local:

| Variable | En producción |
|---|---|
| `NODE_ENV` | `production` |
| `COOKIE_SECURE` | `true` |
| `APP_URL` | `https://acostaresearch.com` |
| `CORS_ORIGIN` | El dominio real, sin `localhost` |
| `MCP_PUBLIC_URL` | `https://api.acostaresearch.com/mcp` |
| `DATABASE_URL` | La de Clever Cloud |
| `SKILLS_DIR`, `PROOFS_DIR`, `GUIAS_DIR` | Las de `/var/lib/acostaresearch` |
| `NTFY_TOPIC` | El tópico de los avisos al móvil |
| `GUIA_URL` | Vacía. Ver abajo |
| `PAYPAL_ENV` | `sandbox` mientras no se pase a `live` |

> **PayPal en `live` usa otras credenciales.** Las del sandbox no valen: hay que
> sacar las de la aplicación *Live* del panel de PayPal, y poner el Client ID de
> live también en las variables del frontend.

---

## La web

Se publica en **Cloudflare Workers con archivos estáticos**. Estuvo en Netlify
hasta que su plan pausó los despliegues de producción por créditos agotados,
justo el día en que hacía falta publicar un cambio; de ahí la mudanza.

Lo que en Netlify eran tres líneas de `netlify.toml`, aquí lo hace
`worker/index.js`, porque Cloudflare no sabe reenviar a un origen externo con una
regla de redirección:

- **Proxy de `/api/*`** hacia el backend. No es comodidad: el refresh token viaja
  en una cookie `httpOnly` y, si el navegador llamara directo a
  `api.acostaresearch.com`, serían orígenes distintos y haría falta
  `SameSite=None` más CORS con credenciales. Con el proxy todo es del mismo
  origen.
- **Respaldo al `index.html`** para que entrar directo a `/metodo` o recargar con
  F5 no dé 404.

El Worker solo se ejecuta cuando la petición **no** coincide con un archivo del
build: los estáticos los sirve Cloudflare desde su borde.

### Variables del frontend

Se configuran en el panel de Cloudflare (*Settings → Build → Variables*) y las lee
`scripts/generar-environment.js` al compilar:

```
API_URL=/api/v1          NODE_VERSION=22
GOOGLE_CLIENT_ID         PAYPAL_CLIENT_ID
WHATSAPP_URL  TIKTOK_URL  YOUTUBE_URL  INSTAGRAM_URL
FACEBOOK_URL  SCHOLAR_URL  CTIVITAE_URL
```

**Si faltan `GOOGLE_CLIENT_ID` o `PAYPAL_CLIENT_ID`, los dos botones desaparecen
sin ningún error visible**: el generador deja el valor vacío y las plantillas
ocultan el botón.

---

## El DNS

Está en Cloudflare. Tres registros importan:

| Nombre | Tipo | Contenido | Proxy |
|---|---|---|---|
| `api` | A | `2.28.64.216` | **Gris** |
| `@` | Worker | `frontend-acostaresearch` | Naranja |
| `www` | Worker | `frontend-acostaresearch` | Naranja |

**`api` tiene que quedar en gris.** Con el proxy naranja, Cloudflare
interceptaría la validación de Let's Encrypt por el puerto 80 y, peor,
almacenaría en búfer las respuestas del conector MCP, que son en streaming: el
Claude del comprador se quedaría esperando.

Los dos de la web van en naranja **por obligación**: con Workers es Cloudflare
quien pone el certificado.

El resto de registros son el correo —tres `MX` de Cloudflare Email Routing, el
SPF, el DMARC y las dos `brevo*._domainkey`— y **no se tocan**. El SPF autoriza a
Cloudflare y a Brevo:

```
v=spf1 include:_spf.mx.cloudflare.net include:spf.brevo.com ~all
```

Solo puede haber **un** registro SPF. Dos se tratan como error de configuración y
es peor que no tener ninguno.

---

## La guía de instalación

El correo de compra enlaza un PDF con capturas. Vive en dos sitios:

- `acostaresearch-frontend/public/guias/guia-instalacion.pdf` → lo publica la web
- `/var/lib/acostaresearch/guias/` → lo sirve el backend

`GUIA_URL` decide cuál se enlaza en el correo. **Vacía** enlaza la copia de la
web, que es lo normal. Se rellena con la del backend cuando la web no se pueda
desplegar —pasó con Netlify— para no depender de un tercero.

Si el enlace apunta a un archivo que no existe, la web responde su `index.html` y
al comprador **se le descarga la portada con extensión `.pdf`** en el correo en
que acaba de pagar. Por eso el script de despliegue de respaldo comprueba también
el PDF, no solo la portada.

---

## Los avisos al móvil

Cuando entra un comprobante de Yape, además del correo al administrador sale un
aviso por **ntfy** al teléfono. Un correo se lee cuando uno abre el correo, y un
comprobante espera a que alguien lo mire: cada hora de retraso es una hora que
alguien que ya pagó pasa sin su acceso.

Se configura con `NTFY_TOPIC`. Sin esa variable no se llama a ningún servidor: el
aviso se queda en el log, que es lo que hace falta en desarrollo.

**El tópico es la credencial.** En el plan gratuito de ntfy los tópicos no se
reservan: cualquiera que acierte el nombre lee los avisos. Por eso es largo y
aleatorio, y por eso el aviso **no lleva el correo del comprador** — solo nombre
de pila, inicial, importe y plan. Quién es y su comprobante están detrás del
panel, que pide sesión.

---

## Las migraciones

Las aplica `desplegar.sh` con `npx prisma migrate deploy`, que solo aplica lo
pendiente y nunca borra datos.

⚠️ **No lo automatices en el arranque.** Una migración histórica no puede
reproducirse sobre una base vacía, así que `migrate deploy` funciona contra
*esta* base pero fallaría partiendo de una nueva. El día que haga falta una base
limpia, hay que rehacer el historial con un `migrate diff` desde el esquema
actual.

---

## Comprobar que todo está bien

```bash
curl https://api.acostaresearch.com/api/v1/health
# {"success":true,"data":{"status":"ok",...}}

curl https://acostaresearch.com/api/v1/billing/plans
# el proxy del Worker funciona; devuelve METODO_9_SKILLS a S/ 199

curl -I https://acostaresearch.com/guias/guia-instalacion.pdf
# Content-Type: application/pdf  ← si dice text/html, el PDF no está publicado

curl -s -X POST -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  https://api.acostaresearch.com/mcp/UN-TOKEN-VALIDO
# tiene que listar las tres herramientas del conector
```

Y a mano: entrar con Google, abrir `/planes`, y desde `/perfil` generar el
conector y probarlo en Claude.

---

## El respaldo

Hay una copia completa de la web servida por el propio Caddy en
`web.2-28-64-216.sslip.io`, desde `/var/www/acostaresearch`. Se actualiza con:

```bash
cd acostaresearch-frontend && npm run deploy:hetzner
```

Sirve para el día que Cloudflare Workers falle —un despliegue roto, un problema
de cuenta—. El cambio son tres pasos:

1. `npm run deploy:hetzner` para refrescar la copia.
2. En Cloudflare: borrar los dominios propios del Worker y crear registros `A`
   hacia `2.28.64.216` con la nube **gris**.
3. Añadir `acostaresearch.com` al Caddyfile y recargar; el certificado sale solo.

**Lo que este respaldo NO cubre:** el DNS también está en Cloudflare. Si se cae su
DNS, el dominio no resuelve y da igual dónde esté alojada la web. Para eso harían
falta servidores de nombres en otro proveedor.

El bloque de Caddy del dominio real no se puede dejar preparado de antemano: Caddy
intentaría sacar un certificado para un dominio que apunta a otro sitio, fallaría
en bucle y acabaría chocando con los límites de Let's Encrypt.

---

## Después de un despliegue nuevo desde cero

Las skills **no viajan en el repositorio**: la carpeta empieza vacía. Entra en
`/admin` → *Capítulos* y suelta los nueve `.skill` en la zona de arrastre.

Los nueve del método son:

```
tema-y-delimitacion        instrumento-investigacion   discusion
problema-y-objetivos       recoleccion-datos           conclusiones-abstract
marco-teorico              analisis-datos-rstudio
metodologia
```

---

## Lo que rompe cosas

| Si haces esto | Pasa esto |
|---|---|
| Poner `api` en naranja | El conector MCP se queda esperando; el certificado deja de renovarse |
| Borrar los `MX` o el SPF | Dejas de enviar y recibir correo; nadie puede verificar su cuenta |
| Guardar las skills o los comprobantes dentro de `/opt` | El siguiente despliegue los borra |
| Tener dos registros SPF | Peor que no tener ninguno |
| Dejar `GUIA_URL` apuntando a un archivo que no existe | El comprador se descarga la portada de la web con extensión `.pdf` |
| Cambiar `MCP_PUBLIC_URL` | Las licencias nuevas salen con esa dirección; las viejas siguen con la anterior |

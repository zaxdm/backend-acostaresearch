# Poner el backend en línea

La web ya está publicada en Netlify y la base de datos ya vive en Clever Cloud.
Lo único que falta es que el servidor de la API deje de correr en tu laptop.

Mientras no lo esté:

- `acostaresearch.netlify.app` carga, pero `/api/*` responde **502**. Nadie puede
  registrarse, entrar, ver el precio ni comprar.
- El conector de Claude apunta a un túnel de Cloudflare que muere al cerrar la
  laptop, y al volver **cambia de dirección**, invalidando el conector que ya
  instalaron los compradores.

---

## 1 · Levantar el servidor

Hay un `Dockerfile` listo. Sirve igual en Railway, Render, Fly o un VPS.

**Railway** es lo más rápido: nuevo proyecto → *Deploy from GitHub repo* →
`zaxdm/backend-acostaresearch`. Detecta el Dockerfile solo.

### El volumen no es opcional

Dos carpetas guardan cosas que **no están en el repositorio**:

| Ruta en el contenedor | Qué hay dentro |
|---|---|
| `/app/data/skills` | Los `.skill` que subes desde el panel |
| `/app/data/comprobantes` | Las capturas de los pagos por Yape |

En Railway y Render el disco es efímero: se borra en cada despliegue. **Monta un
volumen en `/app/data`** antes del primer arranque. Sin él, el día que redespliegues
te quedas sin capítulos que servir y sin los comprobantes de los pagos pendientes
de revisar.

---

## 2 · Variables de entorno

Copia las de tu `.env` local, **con estos cambios**:

| Variable | Valor en producción | Por qué |
|---|---|---|
| `NODE_ENV` | `production` | Activa el modo estricto y apaga los logs de depuración |
| `COOKIE_SECURE` | `true` | La cookie de sesión solo debe viajar por HTTPS |
| `PORT` | el que asigne el hosting | Railway y Render lo inyectan solos |
| `CORS_ORIGIN` | `https://acostaresearch.netlify.app` | Fuera `localhost` y fuera el túnel |
| `MCP_PUBLIC_URL` | `https://TU-BACKEND/mcp` | La dirección definitiva, no un túnel |
| `PAYPAL_ENV` | `live` | Ahora está en `sandbox`: los pagos no son reales |

`DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `SMTP_*`, `MAIL_FROM`,
`GOOGLE_CLIENT_ID`, `YAPE_*` y `APP_URL` se copian tal cual.

> **PayPal en `live` usa otras credenciales.** `PAYPAL_CLIENT_ID` y
> `PAYPAL_CLIENT_SECRET` del sandbox no valen en producción; hay que sacar las
> de la aplicación *Live* en el panel de PayPal, y poner el Client ID de live
> también en el frontend.

### Sobre `ANTHROPIC_API_KEY`

Está vacía, y por eso los tres planes del humanizador (Básico, Tesista,
Intensivo) están **retirados de la venta** (`active: false`). El método de 9
capítulos no la necesita: se entrega como instrucciones y el tesista pone su
propio Claude.

Si algún día contratas la clave, reactivas los tres planes quitando el
`active: false` de `prisma/seed.js` y volviendo a sembrar.

---

## 3 · Las migraciones

La base de datos ya está al día (`prisma migrate status` → *Database schema is up
to date*), así que en el primer despliegue no hay nada que aplicar.

Para los siguientes, desde el servidor:

```bash
npx prisma migrate deploy
```

⚠️ **No lo automatices en el arranque.** Una migración histórica no puede
reproducirse sobre una base vacía, así que `migrate deploy` funciona contra
*esta* base pero fallaría si algún día partieras de una nueva. El día que haga
falta una base limpia, hay que rehacer el historial con un `migrate diff` desde
el esquema actual.

---

## 4 · Enchufar la web

En [`netlify.toml`](../acostaresearch-frontend/netlify.toml) cambia la línea del
proxy:

```toml
[[redirects]]
  from = "/api/*"
  to = "https://TU-BACKEND-REAL/api/:splat"   # ← aquí
  status = 200
  force = true
```

Commit y push: Netlify redespliega solo.

Y en Netlify → *Site settings* → *Environment variables*, deja puestas
`GOOGLE_CLIENT_ID` y `PAYPAL_CLIENT_ID`. **Si faltan, los dos botones
desaparecen sin ningún error visible**: el generador de `environment.ts` deja el
valor vacío y las plantillas ocultan el botón.

---

## 5 · Google

En [console.cloud.google.com](https://console.cloud.google.com) → *Credenciales*
→ tu ID de cliente OAuth, en **Orígenes de JavaScript autorizados**:

```
https://acostaresearch.netlify.app
http://localhost:4200
```

No hacen falta URI de redireccionamiento: Google Identity Services devuelve el
token al navegador, no redirige.

---

## 6 · Comprobar que quedó bien

```bash
curl https://TU-BACKEND/api/v1/health
# {"success":true,"data":{"status":"ok","uptime":…}}

curl https://acostaresearch.netlify.app/api/v1/billing/plans
# tiene que devolver METODO_9_SKILLS a S/ 199, y NINGÚN plan de palabras
```

Y luego, a mano: entrar con Google, abrir `/planes`, y desde `/perfil` generar el
conector y probarlo en Claude.

---

## 7 · Después del primer despliegue

Las skills **no viajan en la imagen**: el volumen empieza vacío. Entra en
`/admin` → *Capítulos* y suelta los nueve `.skill` de golpe en la zona de
arrastre. Un botón y listo.

Los nueve buenos son los que están publicados hoy:

```
tema-y-delimitacion        instrumento-investigacion   discusion
problema-y-objetivos       recoleccion-datos           conclusiones-abstract
marco-teorico              analisis-datos-rstudio
metodologia
```

> En la carpeta `skills/` hay 31 archivos, muchos ajenos al método. Cuidado con
> `metodologia (1).skill`, que era un duplicado exacto de `metodologia.skill`.

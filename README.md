# Acosta Research · API de autenticación

Node + Express 5 + Prisma (MySQL / MariaDB de XAMPP), Brevo (SMTP) para el correo
y la API de Claude para el reescritor académico.
Access token JWT de vida corta + refresh token rotativo en cookie `httpOnly`,
RBAC por roles y verificación de correo.

## Arquitectura

Cada petición recorre siempre las mismas capas, y ninguna capa salta a la de abajo:

```
routes  →  middlewares  →  controller  →  service  →  repository  →  Prisma
(rutas)    (auth, RBAC,     (HTTP:        (reglas    (acceso a
            validación,      cookies,      de         datos)
            rate limit)      status)       negocio)
```

```
src/
├── server.js              Arranque, conexión a BD, apagado ordenado
├── app.js                 Ensamblado de Express (helmet, cors, parsers, rutas)
├── routes.js              Montaje de módulos bajo API_PREFIX
├── config/                env validado con Zod, logger, constantes
├── lib/                   Clientes externos: Prisma, SMTP, plantillas de correo
├── middlewares/           authenticate, authorize, validate, rateLimit, errorHandler
├── shared/                Errores tipados, respuestas, utilidades (hash, JWT, cookies)
└── modules/
    ├── auth/              register, login, refresh, logout, verificación
    ├── users/             perfil propio y listado (solo ADMIN)
    ├── billing/           planes, bolsas de palabras y saldo
    └── rewrite/           reescritor académico por capítulo
```

## Puesta en marcha

1. **Arrancar MySQL en XAMPP**: abrir el panel de control y pulsar *Start* en el
   módulo MySQL.

2. **Crear la base de datos** desde phpMyAdmin (<http://localhost/phpmyadmin>) o
   por consola:

   ```sql
   CREATE DATABASE acostaresearch CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```

3. **Configurar e instalar**:

   ```bash
   cd backend
   npm install
   cp .env.example .env          # ajustar DATABASE_URL y los dos secretos JWT
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"  # generar secretos
   npm run db:migrate -- --name init      # crea las tablas y siembra el admin
   npm run dev
   ```

> `prisma migrate` crea una *shadow database* temporal para calcular las
> migraciones, así que el usuario de MySQL necesita permiso `CREATE DATABASE`.
> El `root` de XAMPP lo tiene; si usas otro usuario, hay que concedérselo.

### Verificación por código

**El registro no crea la cuenta.** Guarda los datos en `pending_registrations` y envía
un código numérico de 6 dígitos, que caduca a los 15 minutos
(`EMAIL_VERIFICATION_TTL_MINUTES`). La fila en `users` nace en `verify-email`, al
acertar el código: una fila en esa tabla significa siempre correo verificado.

Consecuencias de ese orden:

- Registrarse dos veces con un correo aún sin confirmar **no da 409**: se sobrescribe el
  intento anterior. Mientras no se verifique, ese correo no está reservado por nadie.
- `EMAIL_ALREADY_REGISTERED` solo aparece si la cuenta ya existe de verdad.
- Un correo que nunca se confirma no deja usuarios basura: solo un alta pendiente que
  caduca sola.

Un código de 6 dígitos solo son un millón de combinaciones, así que se apoya en tres
defensas a la vez:

- **Va atado a la cuenta**: `verify-email` exige `email` + `code`, así que no se puede
  barrer el espacio de códigos contra «cualquier usuario».
- **Muere a los 5 fallos**: el contador `attempts` invalida el código y obliga a pedir
  otro; la respuesta avisa de los intentos restantes.
- **Rate limit** por IP sobre el endpoint, además del tope por código.

Solo hay un código vigente por usuario: emitir uno nuevo invalida el anterior. Del
código únicamente se guarda su SHA-256, y la comparación es en tiempo constante.

Si el correo falla al registrarse, el alta pendiente **sí queda guardada** y la respuesta
lo indica con `emailSent: false`, para llevar al usuario a la pantalla del código y
ofrecerle reenviarlo sin rellenar el formulario otra vez.

### Envío de correo (Brevo)

Los correos salen por SMTP a través de [Brevo](https://www.brevo.com), con nodemailer.

| Variable      | Valor                                                              |
|---------------|--------------------------------------------------------------------|
| `SMTP_HOST`   | `smtp-relay.brevo.com`                                             |
| `SMTP_PORT`   | `587` (STARTTLS; el `465` requiere `SMTP_SECURE=true`)             |
| `SMTP_USER`   | El login SMTP de Brevo, no siempre igual al correo de la cuenta     |
| `SMTP_PASS`   | La **SMTP key** de <https://app.brevo.com/settings/keys/smtp>       |
| `MAIL_FROM`   | Un remitente **validado** en Brevo                                  |

`SMTP_PASS` es una clave SMTP generada en el panel, **no** la contraseña de la
cuenta. Y `MAIL_FROM` tiene que estar dado de alta como *sender* verificado: si no,
Brevo acepta la conexión pero rechaza el envío.

Si `SMTP_HOST` o `SMTP_PASS` quedan vacíos, no se llama a ningún servidor: el código
de verificación se escribe en el log, que es lo que hace falta para desarrollar.

Al arrancar se ejecuta `transporter.verify()`, así que una contraseña mal puesta se
ve en el log en ese momento y no en el primer registro. Un fallo ahí **no aborta el
arranque**: la API sigue siendo útil aunque el correo no salga.

## Migraciones

El esquema de la base de datos se cambia **siempre** editando `prisma/schema.prisma`
y generando una migración; nunca tocando las tablas a mano en phpMyAdmin. Así el
historial queda versionado en `prisma/migrations/` y cualquier equipo llega al
mismo estado.

```bash
npm run db:migrate                 # crea y aplica una migración (pide el nombre)
npm run db:migrate -- --name añade_telefono
npm run db:status                  # ¿está la BD al día con las migraciones?
npm run db:deploy                  # aplica las migraciones pendientes (producción)
npm run db:reset                   # borra todo, re-aplica y vuelve a sembrar
npm run db:seed                    # solo los datos iniciales
npm run db:studio                  # explorador visual de los datos
```

### El ciclo del día a día

1. Editar `prisma/schema.prisma` (añadir un campo, un modelo, un índice).
2. `npm run db:migrate -- --name descripcion_corta`.
3. Prisma calcula el SQL, lo guarda en `prisma/migrations/` y lo aplica.
4. Regenera el cliente, así que el autocompletado y los tipos salen solos.

`prisma/migrations/` **se versiona en git**. Al bajar cambios de otra persona,
`npm run db:deploy` pone tu base al día.

### Prototipar sin generar migraciones

Mientras el modelo aún se está moviendo mucho:

```bash
npm run db:push                    # empuja el schema a la BD, sin archivo de migración
```

Es más rápido, pero **no deja historial**: sirve para explorar en local. Cuando la
forma se estabilice, `npm run db:migrate` genera la migración definitiva.

### Datos iniciales

`prisma/seed.js` crea un usuario ADMIN ya verificado (credenciales en `SEED_ADMIN_EMAIL`
y `SEED_ADMIN_PASSWORD` del `.env`). Usa `upsert`, así que se puede ejecutar las veces
que haga falta. Lo lanzan solos `db:migrate` y `db:reset`.

> **En Windows**: si `prisma generate` falla con `EPERM ... query_engine-windows.dll.node`,
> es que el servidor de desarrollo tiene el motor cargado y bloquea el archivo. Para el
> `npm run dev`, repite el comando y vuelve a levantarlo.

## Endpoints (`/api/v1`)

| Método | Ruta                      | Acceso        | Descripción                                  |
|--------|---------------------------|---------------|----------------------------------------------|
| GET    | `/health`                 | público       | Estado del servicio                          |
| POST   | `/auth/register`          | público       | Guarda el alta pendiente y envía el código   |
| POST   | `/auth/verify-email`      | público       | **Crea la cuenta** con `email` + `code`      |
| POST   | `/auth/resend-verification` | público     | Emite y envía un código nuevo                |
| POST   | `/auth/login`             | público       | Devuelve `accessToken` + cookie de refresh   |
| POST   | `/auth/refresh`           | cookie        | Rota el refresh y emite un access nuevo      |
| POST   | `/auth/logout`            | cookie        | Cierra la sesión actual                      |
| POST   | `/auth/logout-all`        | Bearer        | Cierra la sesión en todos los dispositivos   |
| GET    | `/users/me`               | Bearer        | Perfil del usuario autenticado               |
| GET    | `/users`                  | Bearer ADMIN  | Listado paginado (`page`, `perPage`, `search`) |
| POST   | `/rewrites`               | Bearer        | Reescribe un texto (`text`, `mode`)           |
| GET    | `/rewrites`               | Bearer        | Historial paginado del usuario               |
| GET    | `/rewrites/:id`           | Bearer        | Original y resultado de una reescritura      |
| GET    | `/billing/plans`          | público       | Planes a la venta, para la web                |
| GET    | `/billing/balance`        | Bearer        | Palabras disponibles y bolsas del usuario     |
| POST   | `/billing/packs`          | Bearer ADMIN  | Activa una bolsa tras confirmar un pago       |
| GET    | `/billing/packs`          | Bearer ADMIN  | Últimas activaciones, con su referencia de pago |

### Forma de las respuestas

```jsonc
// éxito
{ "success": true, "message": "Sesión iniciada.", "data": { "user": {...}, "accessToken": "..." } }

// error
{ "success": false, "error": { "code": "INVALID_CREDENTIALS", "message": "Correo o contraseña incorrectos." } }
```

El campo `error.code` es estable (ver `src/config/constants.js`): el frontend
debe ramificar sobre él, nunca sobre el texto del mensaje. Los códigos clave para
el cliente son `TOKEN_EXPIRED` (dispara el refresh y reintenta la petición),
`EMAIL_NOT_VERIFIED` y `VALIDATION_ERROR` (trae `error.details` con `field` y
`message` por campo, para pintar los errores en el formulario).


## Reescritor académico

Reescribe el texto que **el propio tesista ya escribió** para ganar claridad y
registro académico, **sabiendo en qué capítulo está**: cada capítulo de una tesis
tiene convenciones distintas y romperlas es lo que hace que el asesor lo devuelva.
El caso más claro es el Capítulo IV, donde los resultados se describen pero no se
interpretan: interpretar es tarea del Capítulo V. No redacta la tesis, no inventa fuentes y no sirve para evadir
detectores de IA: el prompt lo prohíbe explícitamente y así se lo dice al modelo.

Tres niveles de intervención (`mode`): `LIGERO` corrige y pule, `ESTANDAR` reescribe
para claridad, `PROFUNDO` además reordena las oraciones dentro de cada párrafo.


### Modelo de negocio: bolsas de palabras

El coste del reescritor es **recurrente** (se paga cada vez que alguien lo usa), así
que el cobro también tiene que serlo. Pero la mayoría de tesistas peruanos paga por
Yape, y **Yape no admite cobros automáticos recurrentes**. La solución es una bolsa de
palabras que **caduca a los 30 días**: para el alumno funciona igual que una
membresía, y para el negocio no exige pasarela de pago para arrancar.

| Plan | Palabras | Precio | Coste estimado (Sonnet) |
|---|---|---|---|
| `PRUEBA` | 2 000 | gratis | ~S/ 0,25 |
| `BASICO` | 10 000 | S/ 19 | ~S/ 1,30 |
| `TESISTA` | 30 000 | S/ 29 | ~S/ 3,85 |
| `INTENSIVO` | 80 000 | S/ 59 | ~S/ 10,30 |

Los precios y las palabras viven en la tabla `plans` y se siembran desde
`prisma/seed.js`: cambiarlos es editar el seed y volver a ejecutarlo.

**Cómo funciona el saldo.** Un usuario puede tener varias bolsas vigentes a la vez
(por ejemplo, si recarga antes de que venza la anterior). El saldo es la suma de todas,
y al consumir se descuenta **empezando por la que antes caduca**, para que no se le
pierda saldo. La caducidad no se guarda como estado: se compara `expiresAt` al
consultar, así que no hace falta ningún proceso que vaya marcando bolsas vencidas.

Al verificar el correo, cada cuenta nueva recibe automáticamente la bolsa `PRUEBA`,
una sola vez por usuario.

**Cobro manual, por ahora.** Cuando alguien te paga por Yape, activas su bolsa con
`POST /billing/packs` indicando el correo, el plan y el código de operación. Queda
registrado quién lo activó y con qué referencia. Cuando haya pasarela, su webhook
llamará al mismo servicio con los mismos datos: no hay que rehacer nada.

**Cuándo se descuenta.** El saldo se comprueba antes de llamar al modelo y se descuenta
**después** de que la respuesta llegue bien. Un fallo del modelo queda registrado pero
no le cuesta palabras al usuario.

### Coste por reescritura

Con `claude-opus-5`, reescribir un capítulo de unas 5.000 palabras cuesta en torno a
**$0,34** (unos S/ 1,28), porque los tokens de razonamiento también se facturan como
salida. Con un paquete de S/ 100 (~$27) de pago único y acceso de por vida, un solo
usuario intensivo puede consumir buena parte de ese margen, así que el módulo **no
funciona sin cuota**:

| Variable | Por defecto | Para qué |
|---|---|---|
| `REWRITE_MAX_WORDS_PER_REQUEST` | 3 000 | Evita envíos enormes y respuestas truncadas |
| `TRIAL_PLAN_CODE` | `PRUEBA` | Plan que se regala al crear la cuenta |
| `REWRITE_EFFORT` | `high` | Primer freno de coste: `medium` suele mantener la calidad |
| `REWRITE_MODEL` | `claude-opus-5` | La calidad del texto **es** el producto |

Las comprobaciones ocurren **antes** de llamar al modelo, porque una vez enviada la
petición el coste ya está incurrido. Un intento fallido queda registrado pero **no
consume cuota**. Cada reescritura guarda sus tokens y su coste estimado, así que el
gasto por usuario es auditable desde la propia base de datos.

El prompt del sistema va marcado con `cache_control`: es idéntico en todas las
peticiones, así que se cachea. El ahorro real depende de que supere el mínimo de
prefijo cacheable del modelo — verifícalo mirando `cachedTokens` en la tabla
`rewrites`: si sale siempre 0, la caché no está entrando.

### Sin clave configurada

Si `ANTHROPIC_API_KEY` está vacía el módulo responde `503 REWRITE_UNAVAILABLE` y lo
avisa al arrancar. El resto de la API sigue funcionando con normalidad.

## Decisiones de seguridad

- **Contraseñas**: Argon2id con parámetros OWASP. Aisladas en `shared/utils/password.js`.
- **Refresh rotativo con detección de reuso**: cada refresh revoca el anterior y emite
  otro de la misma `familyId`. Si llega un token ya revocado se asume robo y se revoca
  la familia completa.
- **Solo hashes en la BD**: de los refresh y de los tokens de verificación se guarda
  el SHA-256; una filtración de la tabla no permite suplantar sesiones.
- **Sin enumeración de usuarios**: el login iguala el coste cuando el correo no existe
  y el reenvío de verificación responde siempre lo mismo.
- **Rate limiting** estricto en login/registro y más estricto aún en envío de correos.
- **`passwordHash` nunca se selecciona** salvo en el flujo de login (`publicSelect`).

## Pendiente para la siguiente iteración

- Recuperación de contraseña (el modelo `VerificationToken` ya está preparado para
  añadir el tipo `PASSWORD_RESET`).
- Dar de alta un dominio propio en Brevo para mejorar la entregabilidad: enviar desde
  una dirección `@gmail.com` a través de un relay ajeno suele acabar en spam, porque
  el SPF de Gmail no autoriza a Brevo.
- Interfaz del reescritor en Angular y streaming del texto al navegador.
- Pasarela de pago y licencias, para que la compra deje de ser manual.
- Tests de integración de los flujos de autenticación.
- Limpieza periódica de refresh tokens revocados y altas pendientes caducadas.

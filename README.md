# Acosta Research · API de autenticación

Node + Express 5 + Prisma (PostgreSQL). Access token JWT de vida corta + refresh
token rotativo en cookie `httpOnly`, RBAC por roles y verificación de correo.

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
├── lib/                   Clientes externos: Prisma, mailer, plantillas
├── middlewares/           authenticate, authorize, validate, rateLimit, errorHandler
├── shared/                Errores tipados, respuestas, utilidades (hash, JWT, cookies)
└── modules/
    ├── auth/              register, login, refresh, logout, verificación
    └── users/             perfil propio y listado (solo ADMIN)
```

## Puesta en marcha

```bash
cd backend
npm install
cp .env.example .env          # completar DATABASE_URL y los dos secretos JWT
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"  # generar secretos
npm run prisma:migrate -- --name init
npm run dev
```

Sin `SMTP_HOST` configurado los correos no se envían: el enlace de verificación
se escribe en el log, que es suficiente para probar en desarrollo.

## Endpoints (`/api/v1`)

| Método | Ruta                      | Acceso        | Descripción                                  |
|--------|---------------------------|---------------|----------------------------------------------|
| GET    | `/health`                 | público       | Estado del servicio                          |
| POST   | `/auth/register`          | público       | Alta de cuenta (queda en `PENDING`)          |
| POST   | `/auth/verify-email`      | público       | Confirma el correo con el token del enlace   |
| POST   | `/auth/resend-verification` | público     | Reenvía el correo de confirmación            |
| POST   | `/auth/login`             | público       | Devuelve `accessToken` + cookie de refresh   |
| POST   | `/auth/refresh`           | cookie        | Rota el refresh y emite un access nuevo      |
| POST   | `/auth/logout`            | cookie        | Cierra la sesión actual                      |
| POST   | `/auth/logout-all`        | Bearer        | Cierra la sesión en todos los dispositivos   |
| GET    | `/users/me`               | Bearer        | Perfil del usuario autenticado               |
| GET    | `/users`                  | Bearer ADMIN  | Listado paginado (`page`, `perPage`, `search`) |

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
- Tests de integración de los flujos de autenticación.
- Limpieza periódica de tokens caducados.

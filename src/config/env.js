'use strict';

const path = require('node:path');
const dotenv = require('dotenv');
const { z } = require('zod');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const booleanish = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

/** Trata la cadena vacía como "no configurado", que es lo que significa en un .env. */
const vacioComoAusente = (esquema) =>
  z
    .union([esquema, z.literal('')])
    .optional()
    .transform((valor) => valor || undefined);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  API_PREFIX: z.string().startsWith('/').default('/api/v1'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatorio'),

  CORS_ORIGIN: z.string().default('http://localhost:4200'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET debe tener al menos 32 caracteres'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET debe tener al menos 32 caracteres'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  JWT_ISSUER: z.string().default('acostaresearch-api'),
  JWT_AUDIENCE: z.string().default('acostaresearch-web'),

  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: booleanish.default('false'),

  EMAIL_VERIFICATION_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  APP_URL: z.string().url().default('http://localhost:4200'),

  // SMTP. Sin host o sin contraseña, los correos se escriben en el log en vez
  // de enviarse: un valor en blanco desactiva el envío, no rompe el arranque.
  SMTP_HOST: vacioComoAusente(z.string()),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: booleanish.default('false'),
  SMTP_USER: vacioComoAusente(z.string()),
  SMTP_PASS: vacioComoAusente(z.string()),
  // Remitente. Tiene que estar dado de alta y validado como «sender» en Brevo,
  // y conviene que sea del dominio propio: un @gmail.com de remitente no puede
  // pasar la alineación de DMARC —Brevo firma con SU dominio, no con el de
  // Google— y acaba en spam aunque el correo salga sin errores.
  MAIL_FROM: z.string().default('no-responder@acostaresearch.com'),
  // Enlace de contacto que aparece en el pie de los correos. Vacío = no se
  // muestra: es preferible callar a ofrecer una vía que no atiende nadie.
  SUPPORT_WHATSAPP_URL: vacioComoAusente(z.string().url()),
  // A dónde responde el tesista. Vacío = responde al remitente.
  // Sirve para poner un buzón que sí se lee sin sacrificar la entrega.
  MAIL_REPLY_TO: vacioComoAusente(z.string().email()),

  // ── Reescritor académico (Claude) ───────────────────────────────────────
  ANTHROPIC_API_KEY: vacioComoAusente(z.string()),
  // El modelo por defecto es el más capaz: la calidad del texto ES el producto.
  REWRITE_MODEL: z.string().default('claude-opus-5'),
  // Primer freno de coste si hace falta: 'medium' suele mantener la calidad.
  REWRITE_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  // Techo por envío: evita respuestas truncadas y facturas sorpresa.
  REWRITE_MAX_WORDS_PER_REQUEST: z.coerce.number().int().positive().default(3000),
  // Plan que se regala al crear la cuenta. Vacío = sin prueba gratuita.
  TRIAL_PLAN_CODE: z.string().default('PRUEBA'),

  // Modo simulado del conector: responde sin llamar a Anthropic, con cifras de
  // consumo verosímiles. Sirve para probar la conversación, el cupo y el coste
  // sin gastar. NUNCA en producción: el arranque lo impide.
  SKILLS_SIMULADAS: booleanish.default('false'),

  // ── Acceso con Google ───────────────────────────────────────────────────
  // Client ID de la app OAuth (console.cloud.google.com → Credenciales). Es
  // público por diseño: viaja en el HTML y Google comprueba el origen. Vacío =
  // no se ofrece el botón y solo queda el acceso con contraseña.
  // Admite varios separados por comas: es normal tener un cliente OAuth para
  // desarrollo y otro para el dominio real. El token solo se acepta si su
  // `aud` es uno de estos, así que la lista no afloja nada — cada entrada
  // sigue siendo un cliente nuestro.
  GOOGLE_CLIENT_ID: vacioComoAusente(z.string()),

  // ── Pasarela de pago (PayPal) ───────────────────────────────────────────
  // Sin credenciales, el módulo responde 503 y la venta sigue siendo manual.
  PAYPAL_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYPAL_CLIENT_ID: vacioComoAusente(z.string()),
  PAYPAL_CLIENT_SECRET: vacioComoAusente(z.string()),

  // ── Pago manual (Yape o transferencia) ──────────────────────────────────
  // El comprador paga con el QR y sube la captura; un administrador la mira y
  // activa el acceso. Es la vía principal en Perú, donde PayPal es minoritario.
  // Vacíos = no se muestran los datos del titular junto al QR, solo el QR.
  YAPE_TITULAR: vacioComoAusente(z.string()),
  YAPE_NUMERO: vacioComoAusente(z.string()),
  // A quién le llega el aviso de que hay un comprobante esperando. Si se deja
  // vacío se busca en la base de datos el primer administrador activo, para
  // que el aviso no se pierda por un .env sin rellenar.
  ADMIN_NOTIFY_EMAIL: vacioComoAusente(z.string().email()),
  // Aviso al móvil cuando entra un comprobante. El correo llega igual; esto es
  // para enterarse sin abrir el correo, que es lo que acorta la espera del
  // comprador.
  //
  // Sin `NTFY_TOPIC` no se llama a ningún servidor: el aviso se queda en el
  // log, que es justo lo que hace falta en desarrollo.
  //
  // El tópico ES la credencial: en el plan gratuito de ntfy cualquiera que
  // acierte el nombre puede leer lo que se publique en él. Por eso se genera
  // largo y aleatorio, y por eso el aviso no lleva datos del comprador.
  NTFY_URL: z.string().url().default('https://ntfy.sh'),
  NTFY_TOPIC: vacioComoAusente(z.string()),
  // Solo si el tópico está reservado con una cuenta de pago. Con uno público
  // sobra.
  NTFY_TOKEN: vacioComoAusente(z.string()),
  // Carpeta de los comprobantes. Como la de skills, tiene que ser persistente:
  // son la prueba de un cobro y hay que poder releerlos meses después.
  PROOFS_DIR: z.string().default(path.resolve(__dirname, '../../storage/comprobantes')),

  // ── Los capítulos escritos ──────────────────────────────────────────────
  // Dónde se guarda el texto de la tesis de cada comprador.
  //
  // EN DISCO Y NO EN LA BASE DE DATOS, y no es una preferencia. La base va por
  // el plan Dev de un proveedor compartido y ya pesa 171 MB, de los cuales 170
  // son el corpus bibliográfico. Una tesis completa ronda el medio mega; dos
  // centenares de tesistas serían cien megas más, encima de una base que ya
  // está donde está. En disco hay 34 GB libres.
  //
  // Vacío = al lado de los comprobantes, que en producción es
  // /var/lib/acostaresearch. Eso lo mete en el respaldo diario sin tener que
  // acordarse de nada.
  CAPITULOS_DIR: vacioComoAusente(z.string()),

  // ── Guía de instalación ─────────────────────────────────────────────────
  // Dónde está el PDF que se le enlaza al comprador, y con qué dirección se le
  // enlaza.
  //
  // La sirve este backend y no la web por una razón práctica: la web se publica
  // en Netlify, y Netlify puede quedarse sin poder desplegar —por créditos, por
  // un build roto, por lo que sea— justo cuando hace falta cambiar el PDF. El
  // correo de compra sale de aquí, así que la guía que ese correo enlaza vive
  // aquí también: una cosa menos que dependa de un tercero.
  //
  // La carpeta va fuera del directorio del código, como skills y comprobantes,
  // para que un despliegue no se la lleve por delante.
  GUIAS_DIR: z.string().default(path.resolve(__dirname, '../../storage/guias')),
  // Dirección pública de la guía. Vacía = se enlaza la copia de la web.
  GUIA_URL: vacioComoAusente(z.string().url()),
  // Techo de la captura. Una foto de pantalla de móvil no pasa de 2-3 MB.
  PROOF_MAX_BYTES: z.coerce.number().int().positive().default(6 * 1024 * 1024),

  // Techo del export bibliográfico que sube un comprador. Un CSV de Scopus con
  // resúmenes ronda los tres kilobytes por fuente, así que ocho megas cubren de
  // sobra las mil largas que caben en el tope por usuario.
  IMPORT_MAX_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),

  // ── Conector MCP (licencias) ────────────────────────────────────────────
  // Base pública de la URL que el comprador pega en Claude. Tiene que ser
  // HTTPS y estar accesible desde internet: Claude llama desde la nube de
  // Anthropic, no desde el equipo del comprador.
  MCP_PUBLIC_URL: z.string().default('http://localhost:3000/mcp'),
  // Producto por defecto al generar códigos de activación.
  LICENSE_PRODUCT_CODE: z.string().default('METODO_9_SKILLS'),
  // Días de vigencia de una licencia nueva. 0 = sin caducidad.
  LICENSE_DURATION_DAYS: z.coerce.number().int().nonnegative().default(0),

  // Carpeta donde viven los bundles (.skill) que sirve el conector. Es la que
  // escribe el panel al subir una skill, así que tiene que ser persistente:
  // en un hosting con disco efímero hay que montarle un volumen.
  SKILLS_DIR: z.string().default(path.resolve(__dirname, '../../../skills')),
  // Techo del .skill que se acepta por el panel. Los del método rondan los
  // 60 KB; el margen es para bundles con muchos materiales de apoyo.
  SKILLS_MAX_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024),

  // ── Corpus bibliográfico (Zotero) ───────────────────────────────────────
  // La biblioteca se cura en Zotero y este servidor la espeja. La clave TIENE
  // QUE SER DE SOLO LECTURA: se crea en zotero.org/settings/keys sin marcar
  // «Allow write access». Así, aunque se filtrara entera, nadie puede borrar
  // ni modificar el corpus; y como el conector no expone ninguna herramienta
  // de escritura, tampoco hay por dónde intentarlo.
  //
  // Vacía = la sincronización y la búsqueda de fuentes quedan apagadas, sin
  // romper nada: el conector sigue sirviendo capítulos como hasta ahora.
  ZOTERO_API_KEY: vacioComoAusente(z.string()),
  // El identificador numérico de la cuenta, no el nombre de usuario.
  ZOTERO_USER_ID: vacioComoAusente(z.string().regex(/^[0-9]+$/, 'ZOTERO_USER_ID es numérico')),
  // Biblioteca de grupo, si el corpus vive en una en vez de en la personal.
  // Con valor, manda sobre ZOTERO_USER_ID.
  ZOTERO_GROUP_ID: vacioComoAusente(z.string().regex(/^[0-9]+$/, 'ZOTERO_GROUP_ID es numérico')),

  // ── El Zotero de cada tesista (OAuth) ───────────────────────────────────
  // Lo de arriba es LA BIBLIOTECA DE LA CASA, con una sola clave que es tuya.
  // Esto es otra cosa: cada comprador conecta la SUYA, y la clave la emite
  // Zotero a su nombre cuando él autoriza.
  //
  // Se registra una vez en zotero.org/oauth/apps y de ahí salen estas dos.
  // Vacías = la conexión no se ofrece y sus rutas no se montan, igual que la
  // página de análisis sin RSTUDIO_URL: una función a medio conectar enseña a
  // desconfiar del resto.
  ZOTERO_OAUTH_CLIENT_KEY: vacioComoAusente(z.string()),
  ZOTERO_OAUTH_CLIENT_SECRET: vacioComoAusente(z.string()),

  // ── La llave con la que se guardan secretos de otros ────────────────────
  // 32 bytes en hexadecimal o en base64: «openssl rand -base64 32».
  //
  // Con ella se cifran las claves de Zotero de los tesistas antes de tocar la
  // base. Si se pierde, esas claves quedan ilegibles y hay que volver a
  // conectar — que es molesto pero no destruye nada: las fuentes ya importadas
  // siguen donde están. Si se filtra JUNTO con un volcado de la base, quedan
  // legibles las claves de todos, así que no vive en el repositorio ni en el
  // respaldo: solo en el `.env` del servidor.
  SECRETS_KEY: vacioComoAusente(z.string()),

  // ── Búsqueda abierta en OpenAlex ────────────────────────────────────────
  // El correo con el que se identifica el conector al buscar. No es cortesía:
  // sin él, OpenAlex atiende por la cola lenta y una búsqueda tarda lo bastante
  // como para que el tesista crea que el conector se colgó.
  //
  // Vacío = se usa MAIL_FROM, que ya es una dirección nuestra y real.
  OPENALEX_MAILTO: vacioComoAusente(z.string()),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const detalle = parsed.error.issues
    .map((issue) => `  · ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  // Fallar en el arranque: es preferible no levantar el servidor mal configurado.
  console.error(`Configuración inválida en .env:\n${detalle}`);
  process.exit(1);
}

const raw = parsed.data;

/**
 * Comprobaciones que solo tienen sentido en producción.
 *
 * La del conector no es cosmética: Claude llama desde la nube de Anthropic, así
 * que una URL en localhost o sin HTTPS simplemente no es alcanzable y el
 * comprador vería un conector que nunca conecta, sin ningún error que lo
 * explique. Es mejor no arrancar.
 */
if (raw.NODE_ENV === 'production') {
  const problemas = [];

  if (!raw.MCP_PUBLIC_URL.startsWith('https://')) {
    problemas.push('MCP_PUBLIC_URL debe empezar por https:// para que Claude pueda conectarse.');
  }
  if (/localhost|127\.0\.0\.1/.test(raw.MCP_PUBLIC_URL)) {
    problemas.push('MCP_PUBLIC_URL apunta a localhost: Claude no llama desde el equipo del comprador.');
  }
  if (!raw.COOKIE_SECURE) {
    problemas.push('COOKIE_SECURE debería ser true en producción.');
  }
  if (raw.SKILLS_SIMULADAS) {
    problemas.push(
      'SKILLS_SIMULADAS está activo: el conector devolvería texto de mentira a clientes reales.',
    );
  }

  if (problemas.length > 0) {
    console.error(`Configuración inválida para producción:\n${problemas.map((p) => `  · ${p}`).join('\n')}`);
    process.exit(1);
  }
}

const env = Object.freeze({
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isDevelopment: raw.NODE_ENV === 'development',
  corsOrigins: raw.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  // El refresh token solo viaja a las rutas que lo necesitan.
  refreshCookiePath: `${raw.API_PREFIX}/auth`,
  // Hace falta host y contraseña: con uno solo, el envío fallaría en cada intento.
  smtpEnabled: Boolean(raw.SMTP_HOST && raw.SMTP_PASS),
  // Con la simulación encendida el conector funciona sin clave. La doble
  // condición no es redundante: aunque el arranque ya lo impide en producción,
  // esta es la que consulta el código, y conviene que no dependa de otra
  // comprobación hecha treinta líneas más arriba.
  skillsSimuladas: raw.SKILLS_SIMULADAS && raw.NODE_ENV !== 'production',
  rewriteEnabled:
    Boolean(raw.ANTHROPIC_API_KEY) || (raw.SKILLS_SIMULADAS && raw.NODE_ENV !== 'production'),
  googleAuthEnabled: Boolean(raw.GOOGLE_CLIENT_ID),
  googleClientIds: (raw.GOOGLE_CLIENT_ID ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
  paypalEnabled: Boolean(raw.PAYPAL_CLIENT_ID && raw.PAYPAL_CLIENT_SECRET),
  // El pago manual no depende de credenciales: basta con que haya un QR en la
  // web. Estos datos son solo el texto que lo acompaña.
  yape: {
    titular: raw.YAPE_TITULAR ?? null,
    numero: raw.YAPE_NUMERO ?? null,
  },
  // Se cuelga de donde estén los comprobantes en vez de pedir otra variable.
  // Así, el día que se mueva el almacenamiento persistente, esto se mueve con
  // él y nadie tiene que acordarse de que existía una segunda ruta.
  capitulosDir:
    raw.CAPITULOS_DIR ?? path.join(path.dirname(raw.PROOFS_DIR), 'capitulos'),
  // El corpus solo se activa con clave y con una biblioteca a la que apuntar.
  zoteroEnabled: Boolean(raw.ZOTERO_API_KEY && (raw.ZOTERO_GROUP_ID || raw.ZOTERO_USER_ID)),
  // La ruta de la biblioteca dentro de la API. Un grupo manda sobre la cuenta
  // personal: si algún día el corpus se mueve a un grupo compartido, basta con
  // rellenar ZOTERO_GROUP_ID y no hay que tocar código.
  zoteroLibrary: raw.ZOTERO_GROUP_ID
    ? `groups/${raw.ZOTERO_GROUP_ID}`
    : raw.ZOTERO_USER_ID
      ? `users/${raw.ZOTERO_USER_ID}`
      : null,
  // Conectar el Zotero propio exige las tres cosas a la vez: las dos de la
  // aplicación registrada en Zotero y la llave con la que se guarda la clave
  // que devuelve. Sin la tercera, el resultado del OAuth acabaría en la base
  // en claro, así que es mejor no ofrecer el botón.
  zoteroOauthEnabled: Boolean(
    raw.ZOTERO_OAUTH_CLIENT_KEY && raw.ZOTERO_OAUTH_CLIENT_SECRET && raw.SECRETS_KEY,
  ),
  paypalApiBase:
    raw.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
});

module.exports = env;

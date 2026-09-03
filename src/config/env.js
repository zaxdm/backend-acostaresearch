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
  MAIL_FROM: z.string().default('lavaya.soport@gmail.com'),

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

  // ── Pasarela de pago (PayPal) ───────────────────────────────────────────
  // Sin credenciales, el módulo responde 503 y la venta sigue siendo manual.
  PAYPAL_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYPAL_CLIENT_ID: vacioComoAusente(z.string()),
  PAYPAL_CLIENT_SECRET: vacioComoAusente(z.string()),

  // ── Conector MCP (licencias) ────────────────────────────────────────────
  // Base pública de la URL que el comprador pega en Claude. Tiene que ser
  // HTTPS y estar accesible desde internet: Claude llama desde la nube de
  // Anthropic, no desde el equipo del comprador.
  MCP_PUBLIC_URL: z.string().default('http://localhost:3000/mcp'),
  // Producto por defecto al generar códigos de activación.
  LICENSE_PRODUCT_CODE: z.string().default('METODO_9_SKILLS'),
  // Días de vigencia de una licencia nueva. 0 = sin caducidad.
  LICENSE_DURATION_DAYS: z.coerce.number().int().nonnegative().default(0),
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
  rewriteEnabled: Boolean(raw.ANTHROPIC_API_KEY),
  paypalEnabled: Boolean(raw.PAYPAL_CLIENT_ID && raw.PAYPAL_CLIENT_SECRET),
  paypalApiBase:
    raw.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
});

module.exports = env;

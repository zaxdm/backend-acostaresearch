'use strict';

const path = require('node:path');
const dotenv = require('dotenv');
const { z } = require('zod');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const booleanish = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

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

  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().positive().default(24),
  APP_URL: z.string().url().default('http://localhost:4200'),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: booleanish.default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default('Acosta Research <no-reply@acostaresearch.com>'),
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
});

module.exports = env;

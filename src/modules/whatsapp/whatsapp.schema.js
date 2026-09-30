'use strict';

const { z } = require('zod');

const HORA = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Formato HH:MM');

const ajustesSchema = z
  .object({
    activo: z.boolean(),
    usarHorario: z.boolean(),
    horaInicio: HORA,
    horaFin: HORA,
    diasLaborables: z
      .array(z.number().int().min(1).max(7))
      .max(7)
      .transform((dias) => [...new Set(dias)].sort().join(',')),
    bienvenida: z.string().trim().max(1000),
    instrucciones: z.string().trim().max(4000),
    palabrasHumano: z.string().trim().max(500),
  })
  .partial();

const idParamSchema = z.object({ id: z.string().uuid() });

const listarQuerySchema = z.object({
  filtro: z.enum(['TODAS', 'PERSONA', 'NO_LEIDAS', 'BLOQUEADAS']).default('TODAS'),
  busqueda: z.string().trim().max(60).optional(),
});

const responderSchema = z.object({ texto: z.string().trim().min(1).max(4000) });

const modoSchema = z.object({ modo: z.enum(['BOT', 'HUMANO']) });

const bloqueoSchema = z.object({ bloqueado: z.boolean() });

const simularSchema = z.object({
  texto: z.string().trim().min(1).max(2000),
  nombre: z.string().trim().max(60).optional(),
  /** Para tener varias conversaciones de prueba a la vez. */
  conversacion: z
    .string()
    .trim()
    .regex(/^[a-z0-9]{1,12}$/i)
    .optional(),
});

module.exports = {
  ajustesSchema,
  idParamSchema,
  listarQuerySchema,
  responderSchema,
  modoSchema,
  bloqueoSchema,
  simularSchema,
};

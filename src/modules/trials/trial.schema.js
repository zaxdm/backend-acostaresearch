'use strict';

const { z } = require('zod');

/**
 * Alta de un enlace de prueba.
 *
 * Los topes van con techo a propósito: cada consulta del conector se paga en
 * tokens, y un cero de más tecleado con prisa en un enlace que se reparte a un
 * grupo entero no se nota hasta que llega la factura. 0 = sin tope, como en
 * las licencias.
 */
const createTrialSchema = z.object({
  name: z
    .string({ required_error: 'Ponle un nombre: para quién es la prueba.' })
    .trim()
    .min(3, 'El nombre necesita al menos 3 caracteres.')
    .max(120),
  productCode: z.string({ required_error: 'Elige el producto.' }).trim().toUpperCase().max(40),
  seats: z.coerce
    .number()
    .int()
    .min(1, 'Al menos un cupo.')
    .max(500, 'Como mucho 500 cupos por enlace.')
    .default(30),
  /**
   * Cuánto dura cada conector, en minutos, desde que el invitado lo recoge.
   *
   * En minutos y no en días porque una prueba de un taller o de un directo dura
   * horas. 0 = sin límite: el conector no caduca, y se corta apagando el enlace.
   * El techo es un año.
   */
  accessMinutes: z.coerce
    .number({ required_error: 'Indica cuánto dura cada conector.' })
    .int('El tiempo de acceso va en minutos enteros.')
    .min(0, 'El tiempo de acceso no puede ser negativo.')
    .max(525600, 'Como mucho un año de acceso.'),
  callsPerDay: z.coerce.number().int().min(0).max(1000).default(0),
  // Sin tope total: un enlace de prueba solo lleva tope por día. Si un panel
  // antiguo manda «callsLimitTotal», zod lo descarta aquí sin dar error.
});

const updateTrialSchema = z.object({
  active: z.boolean({ required_error: 'Indica si el enlace queda encendido o apagado.' }),
});

const idParamSchema = z.object({ id: z.string().uuid('Identificador no válido.') });

/** El trozo aleatorio de la URL pública. Ver `generarSlug`. */
const slugParamSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]{6,40}$/, 'Este enlace de prueba no existe. Revisa que esté bien copiado.'),
});

module.exports = { createTrialSchema, updateTrialSchema, idParamSchema, slugParamSchema };

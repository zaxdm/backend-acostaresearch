'use strict';

const { z } = require('zod');

const { CAPITULOS, NIVELES, AREAS, METODOS } = require('./pedido.catalogo');

/**
 * Lo que acompaña al documento que sube el tesista.
 *
 * Viaja en la query y no en el cuerpo porque el cuerpo es el Word en crudo,
 * igual que las guías en PDF del panel: es un solo archivo, y montar
 * `multipart` añadiría una dependencia para obtener exactamente lo mismo.
 *
 * Se pide lo justo para poder asignar el pedido a alguien que sepa revisarlo
 * —área, enfoque, nivel, universidad— y para poder contestarle. Ni documento de
 * identidad ni dirección: de un tesista no hace falta saber eso, y todo dato
 * que se guarda sin usarlo es solo pasivo.
 */

const texto = (min, max, mensaje) =>
  z.string().trim().min(min, mensaje).max(max, `Como mucho ${max} caracteres.`);

const unoDe = (catalogo, mensaje) =>
  z.string().refine((valor) => Object.keys(catalogo).includes(valor), { message: mensaje });

const pedidoQuerySchema = z.object({
  nombre: texto(3, 160, 'Escribe tu nombre completo: va en la portada de tu trabajo.'),
  email: z.string().trim().toLowerCase().max(255).email('Ese correo no es válido.'),
  telefono: z
    .string()
    .trim()
    .max(20, 'El teléfono es demasiado largo.')
    .regex(/^[+\d\s()-]*$/, 'El teléfono solo lleva números.')
    .optional()
    .default(''),

  universidad: texto(3, 160, 'Escribe el nombre de tu universidad.'),
  nivel: unoDe(NIVELES, 'Elige si es pregrado, maestría o doctorado.'),
  area: unoDe(AREAS, 'Elige tu área.'),
  metodo: unoDe(METODOS, 'Elige el enfoque de tu tesis.'),
  capitulo: unoDe(CAPITULOS, 'Elige qué parte nos mandas.'),
  tema: texto(10, 500, 'Escribe el tema de tu tesis, aunque todavía no sea el definitivo.'),
  // Opcional a propósito: quien no sabe qué pedir es justo quien más necesita
  // que se lo revisen, y obligarle a escribir algo produce «que esté bien».
  mensaje: z.string().trim().max(2000).optional().default(''),
});

const codigoParamSchema = z.object({
  codigo: z
    .string()
    .trim()
    .toLowerCase()
    .min(6, 'Ese código no es válido.')
    .max(16)
    .regex(/^[a-z0-9]+$/, 'Ese código no es válido.'),
});

const slugParamSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(6, 'Ese enlace no es válido.')
    .max(40)
    .regex(/^[a-z0-9-]+$/, 'Ese enlace no es válido.'),
});

const idParamSchema = z.object({
  id: z.string().uuid('Identificador no válido.'),
});

/**
 * Lo que el administrador cambia de un pedido.
 *
 * Todo opcional: el panel manda solo lo que se tocó. Asignar y entregar son dos
 * momentos distintos del mismo pedido y no tienen por qué viajar juntos.
 */
const pedidoPatchSchema = z
  .object({
    estado: z.enum(['RECIBIDO', 'EN_REVISION', 'ENTREGADO', 'CANCELADO']).optional(),
    // Cadena vacía = quitarle el asesor y dejarlo sin asignar.
    asesorId: z.union([z.literal(''), z.string().uuid('Ese asesor no es válido.')]).optional(),
    enlaceObservaciones: z
      .string()
      .trim()
      .max(500)
      .refine((valor) => valor === '' || /^https?:\/\/\S+$/i.test(valor), {
        message: 'Pega el enlace completo del documento, empezando por https://',
      })
      .optional(),
    notas: z.string().trim().max(2000).optional(),
  })
  .refine((datos) => Object.keys(datos).length > 0, { message: 'No hay nada que cambiar.' });

module.exports = {
  pedidoQuerySchema,
  codigoParamSchema,
  slugParamSchema,
  idParamSchema,
  pedidoPatchSchema,
};

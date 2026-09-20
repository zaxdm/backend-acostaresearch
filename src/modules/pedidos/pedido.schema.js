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
  // A quién eligió. Obligatorio: el pedido se manda desde el perfil de un
  // asesor, así que no existe un pedido sin destinatario.
  asesorId: z.string().uuid('Elige a tu asesor antes de enviar.'),
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
 * Lo que la casa cambia de un pedido.
 *
 * Ya no asigna ni entrega —eso es del tesista y del asesor—, así que solo queda
 * anotar y cancelar, que es lo que hace falta cuando algo se tuerce y alguien
 * tiene que poder pararlo.
 */
const pedidoPatchSchema = z
  .object({
    estado: z.literal('CANCELADO').optional(),
    notas: z.string().trim().max(2000).optional(),
  })
  .refine((datos) => Object.keys(datos).length > 0, { message: 'No hay nada que cambiar.' });

/** El enlace del documento de observaciones. Sin él no se entrega. */
const enlaceDeObservaciones = z
  .string()
  .trim()
  .min(1, 'Pega el enlace de tu documento de observaciones.')
  .max(500)
  .refine((valor) => /^https?:\/\/\S+$/i.test(valor), {
    message: 'Pega el enlace completo del documento, empezando por https://',
  });

/** La llave privada del asesor: /asesor/<token>. */
const tokenParamSchema = z.object({
  token: z
    .string()
    .trim()
    .min(16, 'Ese enlace no es válido.')
    .max(64)
    .regex(/^[a-z0-9]+$/i, 'Ese enlace no es válido.'),
});

const entregaSchema = z.object({ enlaceObservaciones: enlaceDeObservaciones });

/**
 * Un mensaje de la conversación.
 *
 * El texto viaja en la query porque el cuerpo es el documento adjunto en
 * crudo, igual que el capítulo. Obligatorio aunque haya archivo: un Word
 * suelto, sin una línea que diga qué es, obliga al otro a abrirlo para
 * enterarse.
 */
const mensajeQuerySchema = z.object({
  texto: texto(1, 2000, 'Escribe tu mensaje.'),
});

/** Al aceptar se puede saludar. Opcional: hay quien solo acepta. */
const aceptarSchema = z.object({
  saludo: z.string().trim().max(2000).optional().default(''),
});

const mensajeParamSchema = z.object({
  mensajeId: z.string().uuid('Ese mensaje no existe.'),
});

/**
 * El motivo del rechazo.
 *
 * Obligatorio y corto. Al tesista le llega, y no es lo mismo «ahora no tengo
 * hueco» —vuelve dentro de un mes— que «esto no es lo mío» —elige a otro con
 * otra especialidad—.
 */
const rechazoSchema = z.object({
  motivo: texto(5, 300, 'Dile en una frase por qué no puedes tomarlo.'),
});

const disponibilidadSchema = z.object({ visible: z.boolean() });

/** Elegir otro asesor tras un rechazo, sin volver a subir el documento. */
const reasignarSchema = z.object({
  asesorId: z.string().uuid('Elige a otro asesor.'),
});

/** La nota del tesista. El comentario es opcional: hay quien solo puntúa. */
const resenaSchema = z.object({
  estrellas: z.coerce
    .number()
    .int()
    .min(1, 'Pon entre una y cinco estrellas.')
    .max(5, 'Pon entre una y cinco estrellas.'),
  comentario: z.string().trim().max(1000).optional().default(''),
});

module.exports = {
  pedidoQuerySchema,
  codigoParamSchema,
  slugParamSchema,
  idParamSchema,
  tokenParamSchema,
  entregaSchema,
  mensajeQuerySchema,
  aceptarSchema,
  mensajeParamSchema,
  rechazoSchema,
  disponibilidadSchema,
  reasignarSchema,
  resenaSchema,
  pedidoPatchSchema,
};

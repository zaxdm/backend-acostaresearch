'use strict';

const { z } = require('zod');

const { AREAS, METODOS, GRADOS, DOCUMENTOS } = require('./asesor.catalogo');

/**
 * Lo que se puede escribir en una ficha de asesor.
 *
 * Se pide lo que hace falta para decidir si entra —quién es, qué acredita y
 * qué puede revisar— y nada más. La cuenta bancaria y la copia del documento
 * se le piden al aprobarlo: ver la nota del modelo `Asesor`.
 */

const texto = (min, max, mensaje) =>
  z.string().trim().min(min, mensaje).max(max, `Como mucho ${max} caracteres.`);

const unoDe = (catalogo, mensaje) =>
  z.string().refine((valor) => Object.keys(catalogo).includes(valor), { message: mensaje });

/** Una o varias claves del catálogo. Al menos una: sin área no hay pedido que asignarle. */
const variosDe = (catalogo, mensaje) =>
  z
    .array(z.string())
    .min(1, mensaje)
    .refine((valores) => valores.every((valor) => Object.keys(catalogo).includes(valor)), {
      message: mensaje,
    });

/** Un enlace opcional. Vacío es válido; lo que no es http(s) no. */
const enlace = (max, mensaje) =>
  z
    .string()
    .trim()
    .max(max, `Como mucho ${max} caracteres.`)
    .refine((valor) => valor === '' || /^https?:\/\/\S+$/i.test(valor), { message: mensaje })
    .optional()
    .default('');

const ANIO_MINIMO = 1960;

const postulacionBodySchema = z
  .object({
    nombre: texto(3, 160, 'Escribe tu nombre completo.'),
    tipoDocumento: unoDe(DOCUMENTOS, 'Elige el tipo de documento.'),
    numeroDocumento: z.string().trim().toUpperCase().max(20),
    email: z.string().trim().toLowerCase().max(255).email('Ese correo no es válido.'),
    telefono: z
      .string()
      .trim()
      .min(6, 'Escribe un teléfono de contacto.')
      .max(20, 'El teléfono es demasiado largo.')
      .regex(/^[+\d\s()-]+$/, 'El teléfono solo lleva números.'),

    grado: unoDe(GRADOS, 'Elige tu grado más alto.'),
    gradoUniversidad: texto(3, 160, 'Escribe la universidad que te otorgó el grado.'),
    gradoAnio: z
      .union([
        z.literal(''),
        z.null(),
        z.coerce
          .number()
          .int()
          .min(ANIO_MINIMO, 'Ese año no parece correcto.')
          .max(new Date().getFullYear(), 'Ese año todavía no ha pasado.'),
      ])
      .optional()
      .transform((valor) => (valor === '' || valor === null || valor === undefined ? null : valor)),
    registroSunedu: z.string().trim().max(255).optional().default(''),
    enlaceCv: enlace(500, 'Pega el enlace completo, empezando por https://'),

    areas: variosDe(AREAS, 'Elige al menos un área.'),
    metodos: variosDe(METODOS, 'Elige al menos un enfoque.'),
    especialidad: texto(3, 160, 'Di cuál es tu especialidad.'),
    universidades: z.string().trim().max(500).optional().default(''),
    anosExperiencia: z.coerce
      .number()
      .int()
      .min(0, 'No puede ser negativo.')
      .max(60, 'Ese número no parece correcto.')
      .optional()
      .default(0),
    presentacion: texto(
      40,
      2000,
      'Cuéntanos en unas frases a cuántos tesistas has asesorado y en qué.',
    ),

    aceptaReglas: z.boolean(),
  })
  .superRefine((datos, ctx) => {
    const documento = DOCUMENTOS[datos.tipoDocumento];
    if (documento && !documento.patron.test(datos.numeroDocumento)) {
      ctx.addIssue({ code: 'custom', path: ['numeroDocumento'], message: documento.mensaje });
    }

    // Sin el sí a las tres reglas no hay ficha. Es la regla que sostiene el
    // servicio —el asesor observa, el tesista escribe—, así que no puede ser
    // una casilla que se salta quien tenga prisa.
    if (!datos.aceptaReglas) {
      ctx.addIssue({
        code: 'custom',
        path: ['aceptaReglas'],
        message: 'Para postular tienes que aceptar las tres reglas.',
      });
    }
  });

/**
 * El alta a mano, desde el panel.
 *
 * Son los mismos campos que la postulación y no una versión recortada: lo que
 * se pide en la ficha es lo que decide una elección en el directorio, y un
 * asesor dado de alta con media ficha sale con media tarjeta. `aceptaReglas`
 * sigue estando porque sigue haciendo falta: aquí significa que el
 * administrador confirma que las aceptó, y queda guardado para el día que haya
 * que recordárselo.
 */
const altaSchema = postulacionBodySchema;

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

/** Lo que decide el administrador sobre una ficha. */
const revisionSchema = z.object({
  estado: z.enum(['PENDIENTE', 'APROBADO', 'RECHAZADO'], {
    message: 'Elige si queda pendiente, aprobada o rechazada.',
  }),
  notas: z.string().trim().max(2000).optional().default(''),
  /** Sacarlo o devolverlo al directorio sin tocar su estado. */
  visible: z.boolean().optional(),
});

const convocatoriaSchema = z.object({
  nombre: texto(3, 120, 'Ponle un nombre para reconocerla.'),
  intro: z.string().trim().max(600).optional().default(''),
});

/**
 * Lo que se le puede cambiar. Todo opcional: el panel manda solo el
 * interruptor que se tocó, y `publica` es el que abre esto al mundo.
 */
const convocatoriaCambioSchema = z
  .object({
    nombre: texto(3, 120, 'Ponle un nombre para reconocerla.').optional(),
    intro: z.string().trim().max(600).optional(),
    abierta: z.boolean().optional(),
    publica: z.boolean().optional(),
  })
  .refine((datos) => Object.keys(datos).length > 0, { message: 'No hay nada que cambiar.' });

module.exports = {
  postulacionBodySchema,
  altaSchema,
  slugParamSchema,
  idParamSchema,
  revisionSchema,
  convocatoriaSchema,
  convocatoriaCambioSchema,
};

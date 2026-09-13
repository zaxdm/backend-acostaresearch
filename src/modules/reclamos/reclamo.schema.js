'use strict';

const { z } = require('zod');

/**
 * Lo que se puede escribir en una hoja de reclamación.
 *
 * Los campos son los del anexo del reglamento, ni uno más: quien reclama no
 * tiene que justificar nada para que su hoja exista. El teléfono y el monto son
 * opcionales porque el anexo los deja así; el correo no, porque es por donde le
 * llegan la copia y la respuesta.
 */

const texto = (min, max, mensaje) =>
  z.string().trim().min(min, mensaje).max(max, `Como mucho ${max} caracteres.`);

const unoDe = (valores, mensaje) =>
  z.string().refine((valor) => valores.includes(valor), { message: mensaje });

/** Cómo es cada documento. Se comprueba aquí para no guardar un DNI de siete cifras. */
const DOCUMENTOS = {
  DNI: { patron: /^\d{8}$/, mensaje: 'El DNI tiene 8 dígitos.' },
  CE: { patron: /^[A-Z0-9]{8,12}$/, mensaje: 'El carné de extranjería tiene entre 8 y 12 caracteres.' },
  PASAPORTE: { patron: /^[A-Z0-9]{6,15}$/, mensaje: 'El pasaporte tiene entre 6 y 15 letras o números.' },
};

const reclamoBodySchema = z
  .object({
    tipo: unoDe(['RECLAMO', 'QUEJA'], 'Elige si es un reclamo o una queja.'),
    nombre: texto(3, 160, 'Escribe tu nombre completo.'),
    tipoDocumento: unoDe(Object.keys(DOCUMENTOS), 'Elige el tipo de documento.'),
    numeroDocumento: z.string().trim().toUpperCase().max(20),
    domicilio: texto(5, 250, 'Escribe tu domicilio.'),
    telefono: z
      .string()
      .trim()
      .max(20, 'El teléfono es demasiado largo.')
      .regex(/^[+\d\s()-]*$/, 'El teléfono solo lleva números.')
      .optional()
      .default(''),
    email: z.string().trim().toLowerCase().max(255).email('Ese correo no es válido.'),
    menorDeEdad: z.boolean().optional().default(false),
    apoderado: z.string().trim().max(160).optional().default(''),
    tipoBien: unoDe(['PRODUCTO', 'SERVICIO'], 'Elige si es un producto o un servicio.'),
    // Vacío o nulo = no reclama un importe, que es lo normal en una queja.
    montoReclamado: z
      .union([
        z.literal(''),
        z.null(),
        z.coerce
          .number()
          .min(0, 'El monto no puede ser negativo.')
          .max(100000, 'Ese monto no parece correcto.'),
      ])
      .optional()
      .transform((valor) => (valor === '' || valor === null || valor === undefined ? null : valor)),
    descripcionBien: texto(3, 500, 'Di qué compraste o contrataste.'),
    detalle: texto(10, 3000, 'Cuenta qué pasó, con al menos una frase.'),
    pedido: texto(5, 2000, 'Di qué solución pides.'),
  })
  .superRefine((datos, ctx) => {
    const documento = DOCUMENTOS[datos.tipoDocumento];
    if (documento && !documento.patron.test(datos.numeroDocumento)) {
      ctx.addIssue({ code: 'custom', path: ['numeroDocumento'], message: documento.mensaje });
    }

    // El anexo pide los datos del padre o la madre cuando reclama un menor.
    if (datos.menorDeEdad && datos.apoderado.length < 3) {
      ctx.addIssue({
        code: 'custom',
        path: ['apoderado'],
        message: 'Si eres menor de edad, escribe el nombre de tu padre, madre o apoderado.',
      });
    }
  });

const respuestaSchema = z.object({
  respuesta: texto(10, 5000, 'Escribe la respuesta: llega tal cual al consumidor.'),
});

const numeroParamSchema = z.object({
  numero: z.coerce.number().int().positive('Número de hoja no válido.'),
});

module.exports = { reclamoBodySchema, respuestaSchema, numeroParamSchema };

'use strict';

const { z } = require('zod');
const { ANALISIS } = require('./mapas.service');

const anio = z.coerce.number().int().min(1900).max(2100).optional().nullable();
const entero = (min, max) => z.coerce.number().int().min(min).max(max).optional().nullable();

/**
 * Lo que pide el panel para armar un mapa de VOSviewer.
 *
 * Los nulos son «como VOSviewer por defecto»: el mínimo lo elige el servidor,
 * el recuento es completo y el 60 % de términos más relevantes. Los textos de
 * excluir y del tesauro van con techo: los escribe una persona, o suben un
 * tesauro de VOSviewer, no un diccionario entero.
 */
const mapaSchema = z
  .object({
    origen: z.enum(['openalex', 'mis-fuentes']),
    analisis: z.enum(Object.keys(ANALISIS)).default('coocurrencia'),
    unidad: z.string().trim().max(40).optional().nullable(),
    tema: z.string().trim().max(300, 'Resume el tema: con unas palabras basta.').optional(),
    desdeAnio: anio,
    hastaAnio: anio,
    cuantas: z.coerce.number().int().min(50).max(1000).optional(),
    recuento: z.enum(['completo', 'fraccionado', 'binario']).optional().nullable(),
    minimo: entero(1, 1000),
    minimoCitas: entero(0, 100000),
    maximo: z.coerce.number().int().min(5).max(1000).optional(),
    maxAutores: entero(1, 1000),
    relevancia: entero(10, 100),
    excluir: z.string().max(5000, 'La lista de términos a excluir es demasiado larga.').optional(),
    sinonimos: z.string().max(60000, 'El tesauro es demasiado largo.').optional(),
  })
  .refine((d) => d.origen !== 'openalex' || (d.tema && d.tema.length >= 3), {
    message: 'Escribe el tema que quieres mapear.',
    path: ['tema'],
  })
  .refine((d) => !d.desdeAnio || !d.hastaAnio || d.desdeAnio <= d.hastaAnio, {
    message: 'El año inicial no puede ser posterior al final.',
    path: ['hastaAnio'],
  })
  .refine((d) => !d.unidad || ANALISIS[d.analisis].unidades.includes(d.unidad), {
    message: 'Esa unidad de análisis no corresponde a ese tipo de análisis.',
    path: ['unidad'],
  })
  // Como en VOSviewer: el recuento fraccionado no existe en citación ni en
  // acoplamiento aquí, y el binario es solo de los términos.
  .refine(
    (d) =>
      !d.recuento ||
      (d.analisis === 'terminos'
        ? ['binario', 'completo'].includes(d.recuento)
        : d.recuento === 'completo' || ['coocurrencia', 'coautoria', 'cocitacion'].includes(d.analisis)),
    { message: 'Ese método de recuento no está disponible para este análisis.', path: ['recuento'] },
  );

module.exports = { mapaSchema, coocurrenciaSchema: mapaSchema };

'use strict';

const { z } = require('zod');

const { IDIOMAS } = require('./preparar.prompt');

const SERVICIOS = ['EDICION', 'TRADUCCION', 'RESUMEN'];

/**
 * Qué servicio y, si toca, a qué idioma.
 *
 * El idioma se comprueba DOS veces: aquí, contra la lista de los cuatro, y en
 * `preparar.service.idiomaDe`, que además exige que venga cuando el servicio es
 * traducción. Lo segundo no se puede hacer aquí sin volver el esquema difícil
 * de leer, y lo primero no se puede dejar solo allí porque esto es la frontera
 * con el navegador.
 */
const encargoSchema = z.object({
  servicio: z.enum(SERVICIOS, {
    errorMap: () => ({
      message: 'Elige uno de los tres servicios: edición, traducción o resumen.',
    }),
  }),
  idioma: z
    .enum(Object.keys(IDIOMAS), {
      errorMap: () => ({ message: 'Solo traducimos a español, inglés, portugués y chino.' }),
    })
    .nullable()
    .optional(),
});

module.exports = { encargoSchema, SERVICIOS };

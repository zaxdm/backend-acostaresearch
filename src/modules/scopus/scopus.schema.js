'use strict';

const { z } = require('zod');

/**
 * La ecuación de búsqueda de Scopus.
 *
 * NO SE VALIDA SU SINTAXIS, Y ES DELIBERADO. El lenguaje de Scopus tiene
 * decenas de campos (`TITLE-ABS-KEY`, `AUTHKEY`, `AFFILCOUNTRY`, `PUBYEAR`…),
 * operadores de proximidad y comodines, y una expresión regular que intentara
 * abarcarlo acabaría rechazando búsquedas legítimas. Quien sabe si la ecuación
 * vale es Scopus, que además explica por qué no vale; aquí solo se acota el
 * tamaño para que nadie mande un megabyte de texto.
 *
 * Tampoco hace falta escaparla: viaja como parámetro de consulta con
 * `URLSearchParams`, que codifica lo que haga falta, y no se concatena en
 * ningún sitio.
 */
const ecuacion = z
  .string({ required_error: 'Escribe qué quieres buscar.' })
  .trim()
  .min(3, 'Escribe al menos tres caracteres.')
  .max(1000, 'Esa ecuación es demasiado larga para Scopus.');

const buscarSchema = z.object({
  ecuacion,
  pagina: z.coerce.number().int().min(1).max(200).optional(),
  orden: z.enum(['citas', 'recientes', 'antiguos', 'relevancia']).optional(),
});

/**
 * El tema que el tesista describe para que la IA le arme la búsqueda.
 *
 * Con techo: es una descripción de su tema, no un capítulo, y lo que se manda
 * a Gemini se paga por palabra.
 */
const consultaSchema = z.object({
  tema: z
    .string({ required_error: 'Describe tu tema.' })
    .trim()
    .min(8, 'Cuéntalo con un poco más de detalle: al menos una frase.')
    .max(800, 'Resúmelo un poco: con dos o tres frases basta.'),
});

/**
 * Lo que vuelve al importar: identificadores, y solo identificadores.
 *
 * Su forma se comprueba otra vez en `scopus.mapper.esEid` antes de armar la
 * consulta. Dos veces y no una: esto rechaza lo que ni siquiera lo parece sin
 * gastar una petición a Elsevier, y aquello garantiza que lo que entra en la
 * ecuación `EID(...)` no lleva paréntesis ni operadores dentro.
 */
const importarSchema = z.object({
  eids: z
    .array(z.string().trim().max(64))
    .min(1, 'No marcaste ningún artículo.')
    .max(25, 'Puedes importar hasta 25 de una vez.'),
});

/**
 * Lo que trae el navegador al volver de Elsevier.
 *
 * Todo opcional a propósito: si el tesista cancela en la pantalla de
 * autorización vuelve con `error=access_denied` y sin código. Rechazarlo aquí
 * como petición inválida le daría un error feo por haber hecho algo
 * perfectamente legítimo; el controlador lo lleva de vuelta al panel diciendo
 * que no autorizó.
 */
const vueltaSchema = z
  .object({
    code: z.string().trim().max(2000).optional(),
    state: z.string().trim().max(64).optional(),
    error: z.string().trim().max(200).optional(),
  })
  .passthrough();

/**
 * Lo que manda la web para el resumen con IA: la pregunta y los artículos de
 * la página, con los datos que ya tiene en pantalla.
 *
 * Se aceptan del navegador y no se vuelven a pedir a Scopus: el resumen solo
 * lo ve quien lo pide y no se guarda, así que alguien que mande datos falsos
 * solo se engaña a sí mismo, y repetir la búsqueda gastaría cuota de Elsevier
 * para nada. Con techo en todo, eso sí: esto acaba en una llamada que se paga.
 */
const fuenteParaResumir = z.object({
  eid: z.string().trim().max(64),
  doi: z.string().trim().max(200).nullable().optional(),
  titulo: z.string().trim().min(1).max(500),
  anio: z.coerce.number().int().min(1800).max(2100).nullable().optional(),
});

const resumirSchema = z.object({
  pregunta: z
    .string({ required_error: 'Escribe qué quieres saber.' })
    .trim()
    .min(3, 'Escribe qué quieres saber.')
    .max(800, 'Acorta un poco la pregunta.'),
  fuentes: z.array(fuenteParaResumir).min(1, 'No hay artículos que resumir.').max(10),
  anteriores: z
    .array(
      z.object({
        pregunta: z.string().trim().max(800),
        respuesta: z.string().trim().max(3000),
      }),
    )
    .max(3)
    .optional(),
});

module.exports = { buscarSchema, consultaSchema, importarSchema, resumirSchema, vueltaSchema };

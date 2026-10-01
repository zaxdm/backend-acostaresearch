'use strict';

const { z } = require('zod');

const { DOMINIOS_BUENOS, revisarCorreo } = require('../../shared/utils/correo');

/**
 * Lo que entra en los sorteos.
 *
 * El correo NO se verifica —ni código por correo ni consulta al buzón—: lo
 * pidió así el administrador, para que apuntarse cueste un solo paso. Sí se
 * mira que sea de un proveedor conocido (Gmail, Hotmail, Outlook…) o de una
 * universidad, y que no traiga una errata como «gmaiol.com»: un premio que se
 * manda a un dominio inventado no le llega a nadie.
 */

/** ¿Proveedor conocido o correo académico (.edu, .edu.pe, .edu.co…)? */
function dominioAdmitido(dominio) {
  return DOMINIOS_BUENOS.has(dominio) || /(^|\.)edu(\.[a-z]{2})?$/.test(dominio);
}

/** El mismo texto lo enseña la web; aquí es el que manda. */
const NO_ADMITIDO =
  'Usa un correo de Gmail, Hotmail, Outlook, Yahoo o iCloud, o el de tu universidad.';

const slugParamSchema = z.object({
  slug: z.string().trim().min(4).max(40),
});

const idParamSchema = z.object({
  id: z.string().uuid('Ese sorteo no existe.'),
});

const participanteParamSchema = z.object({
  id: z.string().uuid('Ese sorteo no existe.'),
  participanteId: z.string().uuid('Ese inscrito no existe.'),
});

const inscripcionSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(255, 'El correo es demasiado largo.')
    .superRefine((correo, ctx) => {
      const { problema, sugerencia } = revisarCorreo(correo);
      if (problema) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: sugerencia ? `${problema} ¿Quisiste decir ${sugerencia}?` : problema,
        });
        return;
      }
      if (!dominioAdmitido(correo.split('@')[1])) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: NO_ADMITIDO });
      }
    }),
  nombre: z.string().trim().max(120, 'Como mucho 120 caracteres.').optional().default(''),
});

const crearSchema = z.object({
  nombre: z
    .string()
    .trim()
    .min(3, 'Ponle un nombre al sorteo.')
    .max(120, 'Como mucho 120 caracteres.'),
});

const cambiarSchema = z.object({
  abierto: z.boolean(),
});

module.exports = {
  slugParamSchema,
  idParamSchema,
  participanteParamSchema,
  inscripcionSchema,
  crearSchema,
  cambiarSchema,
};

'use strict';

const { z } = require('zod');
const { revisarCorreo } = require('../../shared/utils/correo');

const email = z
  .string({ required_error: 'El correo es obligatorio.' })
  .trim()
  .toLowerCase()
  .email('El correo no tiene un formato válido.')
  .max(255);

const password = z
  .string({ required_error: 'La contraseña es obligatoria.' })
  .min(10, 'La contraseña debe tener al menos 10 caracteres.')
  .max(128, 'La contraseña no puede superar los 128 caracteres.')
  .regex(/[a-z]/, 'Debe incluir al menos una letra minúscula.')
  .regex(/[A-Z]/, 'Debe incluir al menos una letra mayúscula.')
  .regex(/\d/, 'Debe incluir al menos un número.');

const name = (campo) =>
  z
    .string({ required_error: `${campo} es obligatorio.` })
    .trim()
    .min(2, `${campo} debe tener al menos 2 caracteres.`)
    .max(80);

const registerSchema = z.object({
  firstName: name('El nombre'),
  lastName: name('El apellido'),
  // Solo al registrarse se buscan erratas como `gamail.com`: a ese correo va el
  // código de activación. En el acceso no, para no dejar fuera a nadie que ya
  // tenga cuenta. El panel avisa mientras se escribe; esto es lo que no se salta.
  email: email.superRefine((valor, ctx) => {
    const { problema, sugerencia } = revisarCorreo(valor);
    if (!problema) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: sugerencia ? `${problema} ¿Quisiste decir ${sugerencia}?` : problema,
    });
  }),
  password,
});

const loginSchema = z.object({
  email,
  // En login no se revalida la política: solo se comprueba contra el hash.
  password: z.string({ required_error: 'La contraseña es obligatoria.' }).min(1),
});

const verifyEmailSchema = z.object({
  email,
  code: z
    .string({ required_error: 'Escribe el código que te enviamos.' })
    .trim()
    .regex(/^[0-9]{6}$/, 'El código son 6 dígitos.'),
  // La del registro. El código prueba que el correo es suyo; esto, que la cuenta
  // que nace es la que él pidió y no la de quien registró su correo detrás.
  password: z
    .string({ required_error: 'Escribe la contraseña con la que te registraste.' })
    .min(1, 'Escribe la contraseña con la que te registraste.')
    .max(128),
});

const resendVerificationSchema = z.object({ email });

const forgotPasswordSchema = z.object({ email });

const resetPasswordSchema = z.object({
  email,
  code: z
    .string({ required_error: 'Escribe el código que te enviamos.' })
    .trim()
    .regex(/^[0-9]{6}$/, 'El código son 6 dígitos.'),
  newPassword: password,
});

/**
 * El token de Google. Se comprueba solo que parezca un JWT: la validación real
 * —firma, emisor, destinatario, caducidad— la hace `google.verifier`, que es
 * el único sitio donde puede hacerse bien.
 */
const googleSchema = z.object({
  credential: z
    .string()
    .min(20, 'Falta el token de Google.')
    .max(4096)
    .regex(/^[\w-]+\.[\w-]+\.[\w-]+$/, 'El token de Google no tiene el formato esperado.'),
});

/**
 * El código del botón «Activar mi acceso» del correo (26-oct). Va en el cuerpo y
 * no en la dirección, para que no quede escrito en los registros del servidor.
 */
const codigoDeActivacion = z
  .string({ required_error: 'Falta el código de activación.' })
  .trim()
  .min(6, 'El código no está completo.')
  .max(40);

const verActivacionSchema = z.object({ codigo: codigoDeActivacion });

/**
 * Activar con una cuenta nueva. El correo no llega aquí: es el del código, el
 * mismo al que se mandó el botón, y lo pone el servidor.
 */
const activarSchema = z.object({
  codigo: codigoDeActivacion,
  firstName: name('El nombre'),
  lastName: name('El apellido'),
  password,
});

module.exports = {
  verActivacionSchema,
  activarSchema,
  googleSchema,
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
};

'use strict';

const { z } = require('zod');

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
  email,
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
});

const resendVerificationSchema = z.object({ email });

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

module.exports = {
  googleSchema,
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  resendVerificationSchema,
};

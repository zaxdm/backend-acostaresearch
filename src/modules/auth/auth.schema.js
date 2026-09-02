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
  token: z.string({ required_error: 'Falta el token de verificación.' }).min(20).max(200),
});

const resendVerificationSchema = z.object({ email });

module.exports = { registerSchema, loginSchema, verifyEmailSchema, resendVerificationSchema };

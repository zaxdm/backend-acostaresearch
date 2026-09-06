'use strict';

const { z } = require('zod');

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().trim().min(1).max(120).optional(),
});

/**
 * La política de contraseñas, copiada de la del alta a propósito.
 *
 * Podría importarse de `auth.schema`, pero entonces los dos módulos quedarían
 * atados por una regla de negocio que no es de ninguno de los dos. Si algún día
 * se endurece, se endurece en los dos sitios, y que el cambio pida tocar dos
 * archivos es un aviso barato de que hay dos puertas al mismo sitio.
 */
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
    .max(80, `${campo} no puede superar los 80 caracteres.`);

/**
 * Editar los datos propios. Solo el nombre y el apellido.
 *
 * El correo NO está aquí y no es un olvido: es el identificador con el que se
 * entra, al que llegan los códigos y con el que se cruzan las compras. Cambiarlo
 * es otra operación, con su propia verificación en el correo nuevo, y mezclarla
 * con «corregir una tilde del apellido» sería regalar una toma de cuenta a quien
 * pille una sesión abierta.
 */
const updateProfileSchema = z.object({
  firstName: name('El nombre'),
  lastName: name('El apellido'),
});

const changePasswordSchema = z.object({
  code: z
    .string({ required_error: 'Escribe el código que te enviamos.' })
    .trim()
    .regex(/^[0-9]{6}$/, 'El código son 6 dígitos.'),
  newPassword: password,
});

/**
 * Crear una cuenta de administrador.
 *
 * No lleva `role`: esta ruta crea administradores y solo administradores. Un
 * campo con el rol invitaría a usarla para dar de alta usuarios normales, que ya
 * se dan de alta solos, y convertiría una puerta estrecha en una general.
 *
 * La contraseña es opcional. Sin ella, el servidor genera una y la manda por
 * correo; con ella, quien crea la cuenta se encarga de hacerla llegar.
 */
const createAdminSchema = z.object({
  firstName: name('El nombre'),
  lastName: name('El apellido'),
  email: z
    .string({ required_error: 'El correo es obligatorio.' })
    .trim()
    .toLowerCase()
    .email('El correo no tiene un formato válido.')
    .max(255),
  password: password.optional(),
});

module.exports = {
  listQuerySchema,
  updateProfileSchema,
  changePasswordSchema,
  createAdminSchema,
};

-- Acceso con Google.
--
-- Estos dos cambios ya estaban en la base de desarrollo y en `schema.prisma`,
-- pero llegaron con `prisma db push`, que no deja migración. El resultado es
-- que cualquier base creada desde el historial —la de producción, sin ir más
-- lejos— salía sin ellos y el acceso con Google fallaba nada más entrar.
-- Esta migración recupera ese paso perdido.

-- Quien entra con Google no tiene contraseña que guardar, y un hash de relleno
-- solo serviría para confundir.
ALTER TABLE `users` MODIFY `passwordHash` VARCHAR(255) NULL;

-- El `sub` de Google: identificador estable de la cuenta. El correo puede
-- cambiar; esto no.
ALTER TABLE `users` ADD COLUMN `googleId` VARCHAR(64) NULL;

CREATE UNIQUE INDEX `users_googleId_key` ON `users`(`googleId`);

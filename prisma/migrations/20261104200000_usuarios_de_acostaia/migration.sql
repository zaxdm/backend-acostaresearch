-- AcostaIA: marca de los titulares espejo que crea el chat propio.
--
-- Solo añade una columna, nula en todas las cuentas que ya existen. Si se
-- revierte el código, la columna puede quedarse.

-- AlterTable
ALTER TABLE `users` ADD COLUMN `acostaiaId` VARCHAR(64) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `users_acostaiaId_key` ON `users`(`acostaiaId`);

-- AcostaIA: el usuario vincula su licencia comprada y AcostaIA usa un conector
-- propio atado a ella (misma cuenta y producto, mismos topes).
--
-- Solo añade dos columnas nulas en todas las licencias que ya existen. Si se
-- revierte el código, pueden quedarse.

-- AlterTable
ALTER TABLE `licenses` ADD COLUMN `acostaiaDeId` CHAR(36) NULL,
    ADD COLUMN `acostaiaId` VARCHAR(64) NULL;

-- CreateIndex
CREATE INDEX `licenses_acostaiaDeId_idx` ON `licenses`(`acostaiaDeId`);

-- CreateIndex
CREATE INDEX `licenses_acostaiaId_idx` ON `licenses`(`acostaiaId`);

-- AddForeignKey
ALTER TABLE `licenses` ADD CONSTRAINT `licenses_acostaiaDeId_fkey` FOREIGN KEY (`acostaiaDeId`) REFERENCES `licenses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Varias tesis por persona y método (solo administradores), con una activa.
--
-- El orden importa en MySQL: la clave foránea de `userId` se apoya en el índice
-- único viejo, que empieza por `userId`. Se crea antes el nuevo —que también
-- empieza por `userId`— y así el viejo se puede quitar sin soltar la clave
-- foránea ni dejar la tabla un momento sin ella.
--
-- Las filas que ya existen quedan en la ranura 0, sin nombre y activas.

-- AlterTable
ALTER TABLE `projects` ADD COLUMN `activadaAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `nombre` VARCHAR(80) NULL,
    ADD COLUMN `ranura` INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX `projects_userId_productCode_ranura_key` ON `projects`(`userId`, `productCode`, `ranura`);

-- DropIndex
DROP INDEX `projects_userId_productCode_key` ON `projects`;

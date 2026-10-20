-- Las guías en PDF se separan en dos bloques: de instalación y de herramientas.
--
-- Solo añade una columna con valor por defecto: las guías que ya hay quedan
-- como «instalacion». Si se revierte el código, la columna puede quedarse.

-- AlterTable
ALTER TABLE `guias` ADD COLUMN `grupo` VARCHAR(20) NOT NULL DEFAULT 'instalacion';

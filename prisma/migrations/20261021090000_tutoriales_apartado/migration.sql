-- Los videos se reparten en las pestañas del video curso: la de su producto,
-- «Instalación» o «Herramientas», como las guías en PDF.
--
-- Solo añade una columna con valor por defecto: los videos que ya hay quedan
-- en la pestaña de su producto. Si se revierte el código, la columna puede quedarse.

-- AlterTable
ALTER TABLE `tutorials` ADD COLUMN `apartado` VARCHAR(20) NOT NULL DEFAULT 'producto';

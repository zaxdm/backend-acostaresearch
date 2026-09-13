-- El asesor del tesista, para la portada del Word. Nulo = no se ha preguntado;
-- vacío = todavía no tiene.

-- AlterTable
ALTER TABLE `projects` ADD COLUMN `asesor` VARCHAR(160) NULL;

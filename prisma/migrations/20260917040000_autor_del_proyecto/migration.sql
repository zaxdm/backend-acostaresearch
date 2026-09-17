-- El autor o tesista de la investigación, para la portada del Word. Nulo = se usa
-- el nombre de la cuenta como respaldo.

-- AlterTable
ALTER TABLE `projects` ADD COLUMN `autor` VARCHAR(160) NULL;

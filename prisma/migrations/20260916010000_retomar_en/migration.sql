-- La fase por la que el tesista eligió retomar desde el panel. Nula en todos
-- los proyectos que ya existen: siguen con la fase que se calculaba antes.

-- AlterTable
ALTER TABLE `projects` ADD COLUMN `retomarEn` VARCHAR(80) NULL;

-- Videos y guías en PDF separados por producto (tesis, informe, tsp…).
-- Texto con comas; vacío = sale en todos, así lo ya publicado no cambia. Solo añade.
-- AlterTable
ALTER TABLE `tutorials` ADD COLUMN `productos` VARCHAR(120) NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE `guias` ADD COLUMN `productos` VARCHAR(120) NOT NULL DEFAULT '';

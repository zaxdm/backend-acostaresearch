-- La ficha del informe estudiantil: curso, docente, integrantes, ciclo y
-- sección, fecha de entrega y rúbrica. Solo la usa el producto de informes;
-- nula en todos los proyectos que ya existen.

-- AlterTable
ALTER TABLE `projects` ADD COLUMN `fichaInforme` JSON NULL;

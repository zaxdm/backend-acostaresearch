-- Qué consejos de la plataforma se le dieron a cada tesis y cuándo, para no
-- repetirlos en cada conversación. Nulo = ninguno todavía.

-- AlterTable
ALTER TABLE `projects` ADD COLUMN `consejos` JSON NULL;

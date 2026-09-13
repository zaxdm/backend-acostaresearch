-- Permiso por licencia para abrir varias tesis del mismo método. Apagado en
-- todas las que ya existen: lo enciende un administrador a quien lo necesite.

-- AlterTable
ALTER TABLE `licenses` ADD COLUMN `variasTesis` BOOLEAN NOT NULL DEFAULT false;

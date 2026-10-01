-- Sorteos en tres vueltas: las dos primeras eliminan y la tercera da el ganador. Solo añade.
-- AlterTable
ALTER TABLE `sorteos` ADD COLUMN `ronda` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `sorteo_participantes` ADD COLUMN `eliminadoEn` INTEGER NULL;

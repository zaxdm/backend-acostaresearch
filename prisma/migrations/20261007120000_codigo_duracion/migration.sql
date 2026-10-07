-- Duración pactada en el código de activación. Nula = la del plan. Solo añade.
-- AlterTable
ALTER TABLE `activation_codes` ADD COLUMN `durationDays` INTEGER NULL;

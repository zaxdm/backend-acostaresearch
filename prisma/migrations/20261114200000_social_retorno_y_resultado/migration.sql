-- Atención en redes: la conversación vuelve al bot si el equipo no escribe en 2 horas,
-- y el equipo marca si la persona compró (para aprender qué vende).
ALTER TABLE `SocialConversacion`
  ADD COLUMN `humanoHasta` DATETIME(3) NULL,
  ADD COLUMN `resultado` VARCHAR(12) NULL,
  ADD COLUMN `resultadoProducto` VARCHAR(40) NULL,
  ADD COLUMN `resultadoAt` DATETIME(3) NULL;

CREATE INDEX `SocialConversacion_humano_humanoHasta_idx` ON `SocialConversacion`(`humano`, `humanoHasta`);

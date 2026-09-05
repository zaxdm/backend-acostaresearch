-- Pago manual por Yape: comprobante + revisión del administrador.
--
-- Se escribe a mano porque `migrate dev` no puede reproducir el historial en la
-- base de datos de sombra (una migración antigua referencia una tabla que se
-- eliminó después). La base real sí está al día, así que el cambio se aplica
-- directamente y se registra con `migrate resolve --applied`.

ALTER TABLE `payments`
  ADD COLUMN `proofPath` VARCHAR(255) NULL,
  ADD COLUMN `proofMime` VARCHAR(40) NULL,
  ADD COLUMN `operationCode` VARCHAR(40) NULL,
  ADD COLUMN `reviewedById` CHAR(36) NULL,
  ADD COLUMN `reviewedAt` DATETIME(3) NULL,
  ADD COLUMN `reviewNote` VARCHAR(255) NULL;

ALTER TABLE `payments`
  MODIFY `status` ENUM('PENDING', 'IN_REVIEW', 'PAID', 'FAILED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING';

CREATE INDEX `payments_status_createdAt_idx` ON `payments`(`status`, `createdAt`);

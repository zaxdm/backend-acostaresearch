-- Planes de Epicuro.ai (10-nov-2026): se venden y se cobran aquí, con Culqi o
-- Hotmart, y Epicuro pregunta por el correo qué plan tiene cada persona.
--
-- Lo que añade:
--   · Un tipo de plan nuevo, EPICURO. Su `productCode` dice el nivel
--     (ESTANDAR o POWER).
--   · `epicuro_planes`: una fila por cuenta con el nivel y hasta cuándo dura.
--   · Los dos planes a la venta: Estándar S/59,90 y Power S/89,90, de 30 días.
--     No salen en la lista pública de acostaresearch.com (ver billing.repository).
--
-- No toca ninguna fila que ya existiera.

-- AlterEnum
ALTER TABLE `plans` MODIFY `kind` ENUM('WORDS', 'LICENSE', 'DOCUMENTO', 'EPICURO') NOT NULL DEFAULT 'WORDS';

-- CreateTable
CREATE TABLE `epicuro_planes` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `nivel` VARCHAR(20) NOT NULL,
    `planCode` VARCHAR(40) NOT NULL,
    `activatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `epicuro_planes_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `epicuro_planes` ADD CONSTRAINT `epicuro_planes_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Los dos planes a la venta.
INSERT INTO `plans` (`id`, `code`, `name`, `description`, `words`, `priceCents`, `currency`, `durationDays`, `active`, `sortOrder`, `kind`, `productCode`, `createdAt`, `updatedAt`)
VALUES
  (UUID(), 'EPICURO_ESTANDAR', 'Epicuro Estándar', 'Plan Estándar de Epicuro.ai por 30 días', 0, 5990, 'PEN', 30, true, 900, 'EPICURO', 'ESTANDAR', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  (UUID(), 'EPICURO_POWER', 'Epicuro Power', 'Plan Power de Epicuro.ai por 30 días', 0, 8990, 'PEN', 30, true, 901, 'EPICURO', 'POWER', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

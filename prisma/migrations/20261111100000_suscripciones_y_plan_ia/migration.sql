-- Plan de tesis + IA y cobro mensual automático con Culqi (10-nov-2026).
--
-- Lo que añade:
--   · En `plans`: `incluyeEpicuro` (un plan que entrega además un plan de
--     Epicuro: la oferta de S/159 = licencia de 1 año + primer mes de IA),
--     `renuevaCon` (el plan que se cobra cada mes con la tarjeta guardada) y
--     `culqiPlanId` (el plan recurrente creado en Culqi).
--   · `suscripciones`: una fila por suscripción de Culqi.
--   · La IA (Epicuro + Huella IA) a su precio nuevo: Estándar S/99,90 y Power
--     S/115 al mes, que se renuevan solos con tarjeta; e IA Estándar anual S/899.
--     Los planes de Epicuro de 59,90 y 89,90 no tenían ventas (decisión del 10-nov).
--
-- No toca ningún otro plan: la oferta de S/159 y las skills de S/100 se arman
-- desde /admin con los campos nuevos.

-- AlterTable
ALTER TABLE `plans`
    ADD COLUMN `incluyeEpicuro` VARCHAR(40) NULL,
    ADD COLUMN `renuevaCon` VARCHAR(40) NULL,
    ADD COLUMN `culqiPlanId` VARCHAR(40) NULL;

-- CreateTable
CREATE TABLE `suscripciones` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `planId` CHAR(36) NOT NULL,
    `primerPagoId` CHAR(36) NOT NULL,
    `estado` ENUM('PENDIENTE', 'ACTIVA', 'CANCELADA', 'FALLIDA') NOT NULL DEFAULT 'PENDIENTE',
    `culqiCustomerId` VARCHAR(40) NOT NULL,
    `culqiCardId` VARCHAR(40) NOT NULL,
    `culqiSubscriptionId` VARCHAR(40) NULL,
    `tarjeta` VARCHAR(60) NULL,
    `proximoCobro` DATETIME(3) NULL,
    `canceladaEn` DATETIME(3) NULL,
    `ultimoError` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `suscripciones_primerPagoId_key`(`primerPagoId`),
    UNIQUE INDEX `suscripciones_culqiSubscriptionId_key`(`culqiSubscriptionId`),
    INDEX `suscripciones_userId_idx`(`userId`),
    INDEX `suscripciones_estado_idx`(`estado`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `suscripciones` ADD CONSTRAINT `suscripciones_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `suscripciones` ADD CONSTRAINT `suscripciones_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `plans`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- La IA a su precio nuevo, renovándose sola con la tarjeta.
UPDATE `plans` SET `name` = 'IA Estándar · Epicuro + Huella IA',
    `description` = 'Epicuro.ai Estándar y el detector Huella IA (5 trabajos al día) por 30 días',
    `priceCents` = 9990, `renuevaCon` = 'EPICURO_ESTANDAR', `updatedAt` = CURRENT_TIMESTAMP(3)
  WHERE `code` = 'EPICURO_ESTANDAR';
UPDATE `plans` SET `name` = 'IA Power · Epicuro + Huella IA',
    `description` = 'Epicuro.ai Power y el detector Huella IA (5 trabajos al día) por 30 días',
    `priceCents` = 11500, `renuevaCon` = 'EPICURO_POWER', `updatedAt` = CURRENT_TIMESTAMP(3)
  WHERE `code` = 'EPICURO_POWER';

-- La anual: pago único de 365 días, sin renovación automática.
INSERT INTO `plans` (`id`, `code`, `name`, `description`, `words`, `priceCents`, `currency`, `durationDays`, `active`, `sortOrder`, `kind`, `productCode`, `createdAt`, `updatedAt`)
SELECT UUID(), 'EPICURO_ESTANDAR_ANUAL', 'IA Estándar anual · Epicuro + Huella IA', 'Epicuro.ai Estándar y el detector Huella IA (5 trabajos al día) por 12 meses', 0, 89900, 'PEN', 365, true, 902, 'EPICURO', 'ESTANDAR', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
WHERE NOT EXISTS (SELECT 1 FROM `plans` WHERE `code` = 'EPICURO_ESTANDAR_ANUAL');

-- Billeteras digitales de país (Deuna en Ecuador, Nequi en Colombia…): el
-- equivalente a Yape fuera de Perú. Las crea el dueño desde el panel y cada
-- pago por una de ellas queda enganchado aquí. Solo añade.

-- AlterTable
ALTER TABLE `payments` ADD COLUMN `billeteraId` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `billeteras` (
    `id` CHAR(36) NOT NULL,
    `nombre` VARCHAR(60) NOT NULL,
    `pais` VARCHAR(2) NOT NULL,
    `moneda` VARCHAR(3) NOT NULL,
    `titular` VARCHAR(120) NOT NULL,
    `numero` VARCHAR(80) NOT NULL,
    `instrucciones` VARCHAR(500) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `billeteras_pais_active_idx`(`pais`, `active`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `payments_billeteraId_idx` ON `payments`(`billeteraId`);

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_billeteraId_fkey` FOREIGN KEY (`billeteraId`) REFERENCES `billeteras`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;


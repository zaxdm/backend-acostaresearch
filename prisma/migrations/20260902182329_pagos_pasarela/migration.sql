-- AlterTable
ALTER TABLE `plans` ADD COLUMN `priceUsdCents` INTEGER NULL;

-- CreateTable
CREATE TABLE `payments` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `planId` CHAR(36) NOT NULL,
    `provider` VARCHAR(20) NOT NULL,
    `providerOrderId` VARCHAR(120) NOT NULL,
    `providerCaptureId` VARCHAR(120) NULL,
    `status` ENUM('PENDING', 'PAID', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `amountCents` INTEGER NOT NULL,
    `currency` VARCHAR(3) NOT NULL,
    `wordPackId` CHAR(36) NULL,
    `payerEmail` VARCHAR(255) NULL,
    `errorCode` VARCHAR(60) NULL,
    `rawResponse` MEDIUMTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `paidAt` DATETIME(3) NULL,

    UNIQUE INDEX `payments_wordPackId_key`(`wordPackId`),
    INDEX `payments_userId_createdAt_idx`(`userId`, `createdAt`),
    UNIQUE INDEX `payments_provider_providerOrderId_key`(`provider`, `providerOrderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `plans`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_wordPackId_fkey` FOREIGN KEY (`wordPackId`) REFERENCES `word_packs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;


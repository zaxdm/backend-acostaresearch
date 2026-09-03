
-- AlterTable
ALTER TABLE `rewrites` ADD COLUMN `chapter` ENUM('GENERAL', 'CAP_I_PROBLEMA', 'CAP_II_MARCO_TEORICO', 'CAP_III_METODOLOGIA', 'CAP_IV_RESULTADOS', 'CAP_V_DISCUSION', 'CAP_VI_CONCLUSIONES', 'RESUMEN_ABSTRACT') NOT NULL DEFAULT 'GENERAL';

-- CreateTable
CREATE TABLE `plans` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `description` VARCHAR(255) NULL,
    `words` INTEGER NOT NULL,
    `priceCents` INTEGER NOT NULL,
    `currency` VARCHAR(3) NOT NULL DEFAULT 'PEN',
    `durationDays` INTEGER NOT NULL DEFAULT 30,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `plans_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `word_packs` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `planId` CHAR(36) NOT NULL,
    `wordsTotal` INTEGER NOT NULL,
    `wordsUsed` INTEGER NOT NULL DEFAULT 0,
    `status` ENUM('ACTIVE', 'EXHAUSTED', 'REVOKED') NOT NULL DEFAULT 'ACTIVE',
    `activatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `paymentMethod` VARCHAR(30) NULL,
    `paymentRef` VARCHAR(80) NULL,
    `amountCents` INTEGER NULL,
    `note` VARCHAR(255) NULL,
    `grantedById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `word_packs_userId_status_expiresAt_idx`(`userId`, `status`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `word_packs` ADD CONSTRAINT `word_packs_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `word_packs` ADD CONSTRAINT `word_packs_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `plans`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


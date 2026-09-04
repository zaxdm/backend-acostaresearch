-- AlterTable
ALTER TABLE `license_counters` ADD COLUMN `callsLifetime` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `costCentsLifetime` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `licenses` ADD COLUMN `callsLimitTotal` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `costCentsLimitTotal` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `payments` ADD COLUMN `discountCents` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `discountCodeId` CHAR(36) NULL;

-- AlterTable
ALTER TABLE `plans` ADD COLUMN `mcpCallsTotal` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `mcpCostCentsTotal` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `discount_codes` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `amountCents` INTEGER NOT NULL,
    `planCode` VARCHAR(40) NULL,
    `maxUses` INTEGER NOT NULL DEFAULT 0,
    `usedCount` INTEGER NOT NULL DEFAULT 0,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `expiresAt` DATETIME(3) NULL,
    `note` VARCHAR(255) NULL,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `discount_codes_code_key`(`code`),
    INDEX `discount_codes_active_expiresAt_idx`(`active`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_discountCodeId_fkey` FOREIGN KEY (`discountCodeId`) REFERENCES `discount_codes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;


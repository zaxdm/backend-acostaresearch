-- AlterTable
ALTER TABLE `license_usages` ADD COLUMN `cachedTokens` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `costCents` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `inputTokens` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `kind` ENUM('NORMAL', 'EXTRACTION_ATTEMPT', 'BLOCKED_LIMIT') NOT NULL DEFAULT 'NORMAL',
    ADD COLUMN `outputTokens` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `licenses` ADD COLUMN `callsPerDay` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `callsPerMonth` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `costCentsPerMonth` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `lastCheckedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `plans` ADD COLUMN `mcpCallsPerDay` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `mcpCallsPerMonth` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `mcpCostCentsPerMonth` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `license_counters` (
    `licenseId` CHAR(36) NOT NULL,
    `callsToday` INTEGER NOT NULL DEFAULT 0,
    `callsMonth` INTEGER NOT NULL DEFAULT 0,
    `costCentsToday` INTEGER NOT NULL DEFAULT 0,
    `costCentsMonth` INTEGER NOT NULL DEFAULT 0,
    `dayStamp` VARCHAR(10) NOT NULL,
    `monthStamp` VARCHAR(7) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`licenseId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `license_alerts` (
    `id` CHAR(36) NOT NULL,
    `licenseId` CHAR(36) NOT NULL,
    `kind` ENUM('VOLUMEN', 'SESIONES_SOLAPADAS', 'CONSULTAS_INCOHERENTES', 'EXTRACCION') NOT NULL,
    `level` ENUM('ALERTA', 'SOSPECHA_ALTA') NOT NULL,
    `action` ENUM('NINGUNA', 'NOTIFICADO', 'REVOCADO') NOT NULL DEFAULT 'NINGUNA',
    `detalle` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `license_alerts_licenseId_createdAt_idx`(`licenseId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `license_counters` ADD CONSTRAINT `license_counters_licenseId_fkey` FOREIGN KEY (`licenseId`) REFERENCES `licenses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `license_alerts` ADD CONSTRAINT `license_alerts_licenseId_fkey` FOREIGN KEY (`licenseId`) REFERENCES `licenses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


-- CreateTable
CREATE TABLE `mcp_sessions` (
    `id` CHAR(36) NOT NULL,
    `licenseId` CHAR(36) NOT NULL,
    `skillCode` VARCHAR(64) NOT NULL,
    `clientKey` VARCHAR(64) NOT NULL,
    `messages` LONGTEXT NOT NULL,
    `containerId` VARCHAR(120) NULL,
    `expiresAt` DATETIME(3) NULL,
    `turns` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `mcp_sessions_licenseId_updatedAt_idx`(`licenseId`, `updatedAt`),
    UNIQUE INDEX `mcp_sessions_licenseId_clientKey_key`(`licenseId`, `clientKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `mcp_sessions` ADD CONSTRAINT `mcp_sessions_licenseId_fkey` FOREIGN KEY (`licenseId`) REFERENCES `licenses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


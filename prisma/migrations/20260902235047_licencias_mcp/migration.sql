-- CreateTable
CREATE TABLE `activation_codes` (
    `id` CHAR(36) NOT NULL,
    `codeHash` CHAR(64) NOT NULL,
    `hint` VARCHAR(12) NOT NULL,
    `productCode` VARCHAR(40) NOT NULL,
    `status` ENUM('AVAILABLE', 'REDEEMED', 'VOID') NOT NULL DEFAULT 'AVAILABLE',
    `buyerEmail` VARCHAR(255) NULL,
    `note` VARCHAR(255) NULL,
    `createdById` CHAR(36) NULL,
    `redeemedById` CHAR(36) NULL,
    `redeemedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `activation_codes_codeHash_key`(`codeHash`),
    INDEX `activation_codes_productCode_status_idx`(`productCode`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `licenses` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `productCode` VARCHAR(40) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `tokenHint` VARCHAR(12) NOT NULL,
    `status` ENUM('ACTIVE', 'SUSPENDED', 'REVOKED') NOT NULL DEFAULT 'ACTIVE',
    `activationCodeId` CHAR(36) NULL,
    `callsTotal` INTEGER NOT NULL DEFAULT 0,
    `lastUsedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `revokedReason` VARCHAR(255) NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `licenses_tokenHash_key`(`tokenHash`),
    UNIQUE INDEX `licenses_activationCodeId_key`(`activationCodeId`),
    INDEX `licenses_userId_status_idx`(`userId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `license_usages` (
    `id` CHAR(36) NOT NULL,
    `licenseId` CHAR(36) NOT NULL,
    `tool` VARCHAR(60) NOT NULL,
    `promptHash` CHAR(64) NULL,
    `sessionId` VARCHAR(64) NULL,
    `ok` BOOLEAN NOT NULL DEFAULT true,
    `durationMs` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `license_usages_licenseId_createdAt_idx`(`licenseId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `licenses` ADD CONSTRAINT `licenses_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `licenses` ADD CONSTRAINT `licenses_activationCodeId_fkey` FOREIGN KEY (`activationCodeId`) REFERENCES `activation_codes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `license_usages` ADD CONSTRAINT `license_usages_licenseId_fkey` FOREIGN KEY (`licenseId`) REFERENCES `licenses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


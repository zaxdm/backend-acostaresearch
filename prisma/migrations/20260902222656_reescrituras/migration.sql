
-- CreateTable
CREATE TABLE `rewrites` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `mode` ENUM('LIGERO', 'ESTANDAR', 'PROFUNDO') NOT NULL DEFAULT 'ESTANDAR',
    `status` ENUM('COMPLETED', 'FAILED') NOT NULL,
    `sourceText` MEDIUMTEXT NOT NULL,
    `resultText` MEDIUMTEXT NULL,
    `sourceWords` INTEGER NOT NULL,
    `model` VARCHAR(60) NOT NULL,
    `inputTokens` INTEGER NOT NULL DEFAULT 0,
    `outputTokens` INTEGER NOT NULL DEFAULT 0,
    `cachedTokens` INTEGER NOT NULL DEFAULT 0,
    `costUsd` DECIMAL(10, 6) NOT NULL DEFAULT 0,
    `errorCode` VARCHAR(60) NULL,
    `durationMs` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `rewrites_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `rewrites` ADD CONSTRAINT `rewrites_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


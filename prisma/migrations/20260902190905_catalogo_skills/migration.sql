-- CreateTable
CREATE TABLE `skills` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(64) NOT NULL,
    `orden` INTEGER NOT NULL,
    `displayName` VARCHAR(120) NOT NULL,
    `summary` VARCHAR(500) NOT NULL,
    `bundlePath` VARCHAR(255) NOT NULL,
    `anthropicSkillId` VARCHAR(80) NULL,
    `anthropicVersionId` VARCHAR(80) NULL,
    `skillMdBytes` INTEGER NOT NULL DEFAULT 0,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `skills_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;


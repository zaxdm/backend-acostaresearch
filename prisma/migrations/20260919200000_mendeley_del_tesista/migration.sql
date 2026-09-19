-- El Mendeley de cada tesista.
--
-- Dos tablas, gemelas de las de Zotero y Scopus: la conexión y el intercambio a
-- medias. Y un valor nuevo en el origen de las fuentes, MENDELEY, para que el
-- tesista pueda pedir «solo lo de Mendeley» y para que la limpieza de lo que
-- sacó de su carpeta no pueda tocar nada que entrara por otra puerta.
--
-- Añadir un valor AL FINAL de un ENUM de MySQL no reescribe las filas que ya
-- existen: es un cambio de metadatos.

-- AlterTable
ALTER TABLE `references` MODIFY `origin` ENUM('ZOTERO', 'SCOPUS', 'MENDELEY') NOT NULL DEFAULT 'ZOTERO';

-- CreateTable
CREATE TABLE `mendeley_accounts` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `profileId` VARCHAR(64) NOT NULL,
    `displayName` VARCHAR(200) NULL,
    -- Cifrados con AES-256-GCM. Ver `shared/utils/secretos.js`.
    `accessTokenCipher` VARCHAR(2000) NOT NULL,
    `refreshTokenCipher` VARCHAR(2000) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `folderId` VARCHAR(64) NULL,
    `folderName` VARCHAR(200) NULL,
    `lastRunAt` DATETIME(3) NULL,
    `lastCount` INTEGER NOT NULL DEFAULT 0,
    `runningSince` DATETIME(3) NULL,
    `lastError` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `mendeley_accounts_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `mendeley_oauth_states` (
    `state` VARCHAR(64) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `mendeley_oauth_states_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`state`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `mendeley_accounts` ADD CONSTRAINT `mendeley_accounts_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

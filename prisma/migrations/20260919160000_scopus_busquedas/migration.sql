-- Las búsquedas guardadas y las conversaciones del copiloto de Scopus. Solo
-- añade una tabla: no toca ninguna de las que ya hay.

-- CreateTable
CREATE TABLE `scopus_busquedas` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `tipo` ENUM('BUSQUEDA', 'COPILOTO') NOT NULL DEFAULT 'BUSQUEDA',
    `titulo` VARCHAR(200) NOT NULL,
    `ecuacion` TEXT NOT NULL,
    `estado` JSON NOT NULL,
    `hilo` JSON NULL,
    `total` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `scopus_busquedas_userId_updatedAt_idx`(`userId`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `scopus_busquedas` ADD CONSTRAINT `scopus_busquedas_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

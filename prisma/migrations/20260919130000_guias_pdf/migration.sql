-- Las guías en PDF que se suben desde el panel. El archivo va a disco; esto es
-- solo su ficha.

-- CreateTable
CREATE TABLE `guias` (
    `id` CHAR(36) NOT NULL,
    `orden` INTEGER NOT NULL DEFAULT 1,
    `titulo` VARCHAR(160) NOT NULL,
    `descripcion` VARCHAR(600) NOT NULL DEFAULT '',
    `archivoNombre` VARCHAR(200) NOT NULL DEFAULT '',
    `bytes` INTEGER NOT NULL DEFAULT 0,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `guias_orden_idx`(`orden`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

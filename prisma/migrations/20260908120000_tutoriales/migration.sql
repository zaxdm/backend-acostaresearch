-- Los videos de la página de tutoriales, editables desde el panel.

CREATE TABLE `tutorials` (
    `id` CHAR(36) NOT NULL,
    `orden` INTEGER NOT NULL,
    `titulo` VARCHAR(160) NOT NULL,
    `duracion` VARCHAR(24) NOT NULL,
    `entrada` VARCHAR(600) NOT NULL,
    `puntos` TEXT NOT NULL,
    `videoUrl` VARCHAR(500) NOT NULL DEFAULT '',
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `tutorials_orden_idx`(`orden`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- La biblioteca de formatos de universidad: el .docx va a disco
-- (formatos-universidad, junto a los comprobantes); esto es su ficha.
--
-- Solo crea una tabla que nadie más usa. Si se revierte el código, la tabla
-- puede quedarse.

-- CreateTable
CREATE TABLE `formatos_universidad` (
    `id` CHAR(36) NOT NULL,
    `universidad` VARCHAR(160) NOT NULL DEFAULT '',
    `alias` VARCHAR(500) NOT NULL DEFAULT '',
    `facultad` VARCHAR(160) NOT NULL DEFAULT '',
    `grado` VARCHAR(20) NOT NULL DEFAULT 'cualquiera',
    `notas` VARCHAR(600) NOT NULL DEFAULT '',
    `archivoNombre` VARCHAR(200) NOT NULL DEFAULT '',
    `bytes` INTEGER NOT NULL DEFAULT 0,
    `sha256` CHAR(64) NOT NULL DEFAULT '',
    `esquema` JSON NULL,
    `esquemaProducto` VARCHAR(40) NULL,
    `aprobado` BOOLEAN NOT NULL DEFAULT true,
    `origenProjectId` CHAR(36) NULL,
    `usos` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `formatos_universidad_aprobado_idx`(`aprobado`),
    INDEX `formatos_universidad_sha256_idx`(`sha256`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

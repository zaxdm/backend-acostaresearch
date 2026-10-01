-- Sorteos de una matrícula del método: el sorteo y sus inscritos. Solo añade.
-- CreateTable
CREATE TABLE `sorteos` (
    `id` CHAR(36) NOT NULL,
    `slug` VARCHAR(40) NOT NULL,
    `nombre` VARCHAR(120) NOT NULL,
    `productCode` VARCHAR(40) NOT NULL,
    `abierto` BOOLEAN NOT NULL DEFAULT true,
    `ganadorId` CHAR(36) NULL,
    `sorteadoAt` DATETIME(3) NULL,
    `codigoHint` VARCHAR(12) NULL,
    `correoEnviado` BOOLEAN NOT NULL DEFAULT false,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sorteos_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sorteo_participantes` (
    `id` CHAR(36) NOT NULL,
    `sorteoId` CHAR(36) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `nombre` VARCHAR(120) NOT NULL DEFAULT '',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `sorteo_participantes_sorteoId_email_key`(`sorteoId`, `email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sorteo_participantes` ADD CONSTRAINT `sorteo_participantes_sorteoId_fkey` FOREIGN KEY (`sorteoId`) REFERENCES `sorteos`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

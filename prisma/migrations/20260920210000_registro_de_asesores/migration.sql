-- El registro de asesores: la convocatoria, que es la puerta, y las fichas que
-- llegan por ella. Nace cerrada al público (`publica` en falso): solo entra
-- quien tenga el slug del enlace.

-- CreateTable
CREATE TABLE `convocatorias` (
    `id` CHAR(36) NOT NULL,
    `slug` VARCHAR(40) NOT NULL,
    `nombre` VARCHAR(120) NOT NULL,
    `abierta` BOOLEAN NOT NULL DEFAULT true,
    `publica` BOOLEAN NOT NULL DEFAULT false,
    `intro` VARCHAR(600) NOT NULL DEFAULT '',
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `convocatorias_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `asesores` (
    `id` CHAR(36) NOT NULL,
    `convocatoriaId` CHAR(36) NOT NULL,
    `nombre` VARCHAR(160) NOT NULL,
    `tipoDocumento` ENUM('DNI', 'CE', 'PASAPORTE') NOT NULL DEFAULT 'DNI',
    `numeroDocumento` VARCHAR(20) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `telefono` VARCHAR(20) NOT NULL,
    `grado` ENUM('BACHILLER', 'MAGISTER', 'DOCTOR') NOT NULL,
    `gradoUniversidad` VARCHAR(160) NOT NULL,
    `gradoAnio` INTEGER NULL,
    `registroSunedu` VARCHAR(255) NOT NULL DEFAULT '',
    `enlaceCv` VARCHAR(500) NOT NULL DEFAULT '',
    `areas` VARCHAR(200) NOT NULL,
    `metodos` VARCHAR(120) NOT NULL,
    `especialidad` VARCHAR(160) NOT NULL,
    `universidades` VARCHAR(500) NOT NULL DEFAULT '',
    `anosExperiencia` INTEGER NOT NULL DEFAULT 0,
    `presentacion` TEXT NOT NULL,
    `aceptaReglas` BOOLEAN NOT NULL DEFAULT false,
    `estado` ENUM('PENDIENTE', 'APROBADO', 'RECHAZADO') NOT NULL DEFAULT 'PENDIENTE',
    `notas` TEXT NULL,
    `revisadoAt` DATETIME(3) NULL,
    `revisadoPorId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `asesores_email_key`(`email`),
    INDEX `asesores_estado_idx`(`estado`),
    INDEX `asesores_convocatoriaId_idx`(`convocatoriaId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `asesores` ADD CONSTRAINT `asesores_convocatoriaId_fkey` FOREIGN KEY (`convocatoriaId`) REFERENCES `convocatorias`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

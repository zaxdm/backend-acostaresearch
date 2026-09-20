-- El otro lado del servicio: el tesista que manda su capítulo para que se lo
-- observen. La puerta es la misma mecánica que la de los asesores, así que la
-- convocatoria gana un tipo en vez de duplicarse en otra tabla.

-- AlterTable
ALTER TABLE `convocatorias` ADD COLUMN `tipo` ENUM('ASESORES', 'REVISION') NOT NULL DEFAULT 'ASESORES';

-- CreateTable
CREATE TABLE `pedidos` (
    `id` CHAR(36) NOT NULL,
    `codigo` VARCHAR(16) NOT NULL,
    `nombre` VARCHAR(160) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `telefono` VARCHAR(20) NOT NULL DEFAULT '',
    `universidad` VARCHAR(160) NOT NULL,
    `nivel` ENUM('PREGRADO', 'MAESTRIA', 'DOCTORADO') NOT NULL DEFAULT 'PREGRADO',
    `area` VARCHAR(40) NOT NULL,
    `metodo` VARCHAR(40) NOT NULL,
    `capitulo` VARCHAR(40) NOT NULL,
    `tema` VARCHAR(500) NOT NULL,
    `mensaje` TEXT NOT NULL,
    `archivoNombre` VARCHAR(200) NOT NULL DEFAULT '',
    `bytes` INTEGER NOT NULL DEFAULT 0,
    `estado` ENUM('RECIBIDO', 'EN_REVISION', 'ENTREGADO', 'CANCELADO') NOT NULL DEFAULT 'RECIBIDO',
    `asesorId` CHAR(36) NULL,
    `enlaceObservaciones` VARCHAR(500) NOT NULL DEFAULT '',
    `notas` TEXT NULL,
    `asignadoAt` DATETIME(3) NULL,
    `entregadoAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `pedidos_codigo_key`(`codigo`),
    INDEX `pedidos_estado_idx`(`estado`),
    INDEX `pedidos_asesorId_idx`(`asesorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
-- SetNull y no Cascade: dar de baja a un asesor no puede llevarse por delante
-- el encargo de un tesista.
ALTER TABLE `pedidos` ADD CONSTRAINT `pedidos_asesorId_fkey` FOREIGN KEY (`asesorId`) REFERENCES `asesores`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

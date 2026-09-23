-- Lo que un cliente opina del servicio.
--
-- Tabla nueva y no una columna más en `resenas`: aquella es la nota que el
-- tesista le pone A SU ASESOR, cuelga de un pedido y sale en la ficha de ese
-- asesor. Esta habla del método y sale en la portada. Juntarlas habría dejado
-- media tabla nula en cada caso.
--
-- Una por cuenta (el índice único sobre `userId`), nace PENDIENTE y no se ve en
-- ningún sitio hasta que un administrador la aprueba desde el panel. `destacada`
-- es un segundo permiso aparte: aprobada = se lee en /resenas; destacada =
-- además sale en la portada, que tiene sitio para tres o cuatro y no para todas.
--
-- En cascada con la cuenta: quien se borra se lleva su testimonio. Un texto
-- firmado por alguien que ya no está no lo podría retirar nadie.

-- CreateTable
CREATE TABLE `resenas_servicio` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `estrellas` INTEGER NOT NULL,
    `comentario` TEXT NOT NULL,
    `nombre` VARCHAR(120) NOT NULL,
    `oficio` VARCHAR(120) NOT NULL DEFAULT '',
    `estado` ENUM('PENDIENTE', 'APROBADA', 'RECHAZADA') NOT NULL DEFAULT 'PENDIENTE',
    `motivo` VARCHAR(500) NOT NULL DEFAULT '',
    `destacada` BOOLEAN NOT NULL DEFAULT false,
    `revisadaPorId` CHAR(36) NULL,
    `revisadaAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `resenas_servicio_userId_key`(`userId`),
    INDEX `resenas_servicio_estado_createdAt_idx`(`estado`, `createdAt`),
    INDEX `resenas_servicio_estado_destacada_createdAt_idx`(`estado`, `destacada`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `resenas_servicio` ADD CONSTRAINT `resenas_servicio_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

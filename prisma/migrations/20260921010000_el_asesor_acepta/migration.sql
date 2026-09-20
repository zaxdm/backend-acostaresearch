-- El tesista elige a su asesor y el encargo le llega directo. Nadie de la casa
-- lo reparte: el que acepta o rechaza es el asesor, y hasta que acepta no ve el
-- documento.

-- El directorio y la llave privada del asesor.
ALTER TABLE `asesores`
    ADD COLUMN `visible` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `token` VARCHAR(64) NULL;

CREATE UNIQUE INDEX `asesores_token_key` ON `asesores`(`token`);

-- Quien ya estaba aprobado recibe su llave aquí mismo: si no, habría que
-- aprobarlo otra vez para que le apareciera, y aprobar dos veces a la misma
-- persona no significa nada.
UPDATE `asesores` SET `token` = REPLACE(UUID(), '-', '') WHERE `estado` = 'APROBADO' AND `token` IS NULL;

-- Los estados nuevos. Se ensancha el enum, se mueven las filas y se estrecha:
-- cambiarlo de un golpe convertiría en cadena vacía lo que ya existe.
ALTER TABLE `pedidos` MODIFY COLUMN `estado`
    ENUM('RECIBIDO', 'ESPERANDO', 'EN_REVISION', 'ENTREGADO', 'RECHAZADO', 'CANCELADO')
    NOT NULL DEFAULT 'ESPERANDO';

UPDATE `pedidos` SET `estado` = 'ESPERANDO' WHERE `estado` = 'RECIBIDO';

ALTER TABLE `pedidos` MODIFY COLUMN `estado`
    ENUM('ESPERANDO', 'EN_REVISION', 'ENTREGADO', 'RECHAZADO', 'CANCELADO')
    NOT NULL DEFAULT 'ESPERANDO';

ALTER TABLE `pedidos`
    ADD COLUMN `motivoRechazo` VARCHAR(300) NOT NULL DEFAULT '',
    ADD COLUMN `aceptadoAt` DATETIME(3) NULL;

-- Lo que el tesista dice de su asesor. Una por pedido: el índice único es lo
-- que impide puntuar diez veces a la misma persona.
CREATE TABLE `resenas` (
    `id` CHAR(36) NOT NULL,
    `pedidoId` CHAR(36) NOT NULL,
    `asesorId` CHAR(36) NOT NULL,
    `estrellas` INTEGER NOT NULL,
    `comentario` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `resenas_pedidoId_key`(`pedidoId`),
    INDEX `resenas_asesorId_idx`(`asesorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `resenas` ADD CONSTRAINT `resenas_pedidoId_fkey` FOREIGN KEY (`pedidoId`) REFERENCES `pedidos`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `resenas` ADD CONSTRAINT `resenas_asesorId_fkey` FOREIGN KEY (`asesorId`) REFERENCES `asesores`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

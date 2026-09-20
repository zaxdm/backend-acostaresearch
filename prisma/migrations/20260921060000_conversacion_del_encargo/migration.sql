-- La conversación de un encargo. Sin ella esto era un buzón: el tesista dejaba
-- un archivo, el asesor devolvía un enlace, y entre medias no se hablaban.
--
-- El adjunto es lo que cierra el ciclo: con las observaciones en la mano, el
-- tesista corrige y vuelve a mandar su documento por aquí.

CREATE TABLE `mensajes` (
    `id` CHAR(36) NOT NULL,
    `pedidoId` CHAR(36) NOT NULL,
    `de` ENUM('TESISTA', 'ASESOR') NOT NULL,
    `texto` TEXT NOT NULL,
    `archivoNombre` VARCHAR(200) NOT NULL DEFAULT '',
    `bytes` INTEGER NOT NULL DEFAULT 0,
    `leidoAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `mensajes_pedidoId_idx`(`pedidoId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `mensajes` ADD CONSTRAINT `mensajes_pedidoId_fkey` FOREIGN KEY (`pedidoId`) REFERENCES `pedidos`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Imágenes del bot de WhatsApp: una galería que sube el equipo en el panel,
-- y en cada mensaje la imagen que llevaba. Solo añade.
-- CreateTable
CREATE TABLE `whatsapp_imagenes` (
    `id` CHAR(36) NOT NULL,
    `nombre` VARCHAR(80) NOT NULL,
    `cuando` VARCHAR(400) NOT NULL DEFAULT '',
    `pie` VARCHAR(1000) NOT NULL DEFAULT '',
    `enBot` BOOLEAN NOT NULL DEFAULT true,
    `archivo` VARCHAR(200) NOT NULL,
    `mime` VARCHAR(20) NOT NULL,
    `bytes` INTEGER NOT NULL,
    `mediaId` VARCHAR(64) NULL,
    `mediaHasta` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `whatsapp_mensajes` ADD COLUMN `imagenId` CHAR(36) NULL;

-- CreateIndex
CREATE INDEX `whatsapp_mensajes_imagenId_idx` ON `whatsapp_mensajes`(`imagenId`);

-- AddForeignKey
ALTER TABLE `whatsapp_mensajes` ADD CONSTRAINT `whatsapp_mensajes_imagenId_fkey` FOREIGN KEY (`imagenId`) REFERENCES `whatsapp_imagenes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

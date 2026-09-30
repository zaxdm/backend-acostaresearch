-- Bot de WhatsApp: una conversación por número, sus mensajes y los ajustes
-- del bot (una sola fila). Los TEXT van sin DEFAULT porque MySQL no lo admite;
-- el valor por defecto lo pone Prisma al crear la fila.
-- CreateTable
CREATE TABLE `whatsapp_conversaciones` (
    `id` CHAR(36) NOT NULL,
    `telefono` VARCHAR(20) NOT NULL,
    `nombre` VARCHAR(120) NOT NULL DEFAULT '',
    `modo` ENUM('BOT', 'HUMANO') NOT NULL DEFAULT 'BOT',
    `bloqueado` BOOLEAN NOT NULL DEFAULT false,
    `pideHumano` BOOLEAN NOT NULL DEFAULT false,
    `noLeidos` INTEGER NOT NULL DEFAULT 0,
    `ultimoDelClienteAt` DATETIME(3) NULL,
    `ultimoMensajeAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `whatsapp_conversaciones_telefono_key`(`telefono`),
    INDEX `whatsapp_conversaciones_ultimoMensajeAt_idx`(`ultimoMensajeAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `whatsapp_mensajes` (
    `id` CHAR(36) NOT NULL,
    `conversacionId` CHAR(36) NOT NULL,
    `autor` ENUM('CLIENTE', 'BOT', 'ADMIN') NOT NULL,
    `texto` TEXT NOT NULL,
    `envio` ENUM('RECIBIDO', 'ENVIADO', 'FALLIDO', 'SIMULADO') NOT NULL,
    `waId` VARCHAR(191) NULL,
    `error` VARCHAR(500) NULL,
    `modelo` VARCHAR(80) NULL,
    `adminId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `whatsapp_mensajes_waId_key`(`waId`),
    INDEX `whatsapp_mensajes_conversacionId_createdAt_idx`(`conversacionId`, `createdAt`),
    INDEX `whatsapp_mensajes_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `whatsapp_ajustes` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `activo` BOOLEAN NOT NULL DEFAULT true,
    `usarHorario` BOOLEAN NOT NULL DEFAULT false,
    `horaInicio` VARCHAR(5) NOT NULL DEFAULT '09:00',
    `horaFin` VARCHAR(5) NOT NULL DEFAULT '18:00',
    `diasLaborables` VARCHAR(20) NOT NULL DEFAULT '1,2,3,4,5',
    `bienvenida` TEXT NOT NULL,
    `instrucciones` TEXT NOT NULL,
    `palabrasHumano` VARCHAR(500) NOT NULL DEFAULT 'hablar con una persona, hablar con alguien, atención humana, asesor humano, operador',
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `whatsapp_mensajes` ADD CONSTRAINT `whatsapp_mensajes_conversacionId_fkey` FOREIGN KEY (`conversacionId`) REFERENCES `whatsapp_conversaciones`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

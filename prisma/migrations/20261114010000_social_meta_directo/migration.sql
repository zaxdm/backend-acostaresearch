ALTER TABLE `SocialConversacion`
 ADD COLUMN `canal` VARCHAR(20) NOT NULL DEFAULT 'externo',
 ADD COLUMN `cuenta` VARCHAR(100) NOT NULL DEFAULT '',
 ADD COLUMN `contacto` VARCHAR(100) NOT NULL DEFAULT '',
 ADD COLUMN `nombre` VARCHAR(120) NOT NULL DEFAULT '',
 ADD COLUMN `noLeidos` INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN `ultimoMensajeAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 ADD COLUMN `ultimoDelClienteAt` DATETIME(3) NULL,
 ADD COLUMN `revision` INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN `queueLease` CHAR(36) NULL,
 ADD COLUMN `queueUntil` DATETIME(3) NULL;
CREATE INDEX `SocialConversacion_ultimoMensajeAt_idx` ON `SocialConversacion` (`ultimoMensajeAt`);
CREATE TABLE `SocialTrabajo` (
 `id` CHAR(36) NOT NULL, `clave` CHAR(64) NOT NULL, `conversacionId` CHAR(36) NOT NULL,
 `autor` VARCHAR(12) NOT NULL, `texto` TEXT NOT NULL, `evento` JSON NOT NULL,
 `respuesta` TEXT NULL, `estado` VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
 `intentos` INTEGER NOT NULL DEFAULT 0, `proximoAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 `metaId` VARCHAR(200) NULL, `error` VARCHAR(300) NULL, `revision` INTEGER NOT NULL DEFAULT 0,
 `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
 PRIMARY KEY (`id`), UNIQUE INDEX `SocialTrabajo_clave_key` (`clave`),
 INDEX `SocialTrabajo_estado_proximoAt_idx` (`estado`, `proximoAt`),
 INDEX `SocialTrabajo_conversacionId_createdAt_idx` (`conversacionId`, `createdAt`),
 INDEX `SocialTrabajo_metaId_idx` (`metaId`),
 CONSTRAINT `SocialTrabajo_conversacionId_fkey` FOREIGN KEY (`conversacionId`) REFERENCES `SocialConversacion` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SocialConversacion` (
  `id` CHAR(36) NOT NULL, `clave` CHAR(64) NOT NULL,
  `humano` BOOLEAN NOT NULL DEFAULT false, `historial` JSON NOT NULL,
  `lease` CHAR(36) NULL, `busyUntil` DATETIME(3) NULL, `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `SocialConversacion_clave_key` (`clave`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `SocialEvento` (
  `clave` CHAR(64) NOT NULL, `respuesta` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`clave`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `SocialPrueba` (
  `contacto` CHAR(64) NOT NULL, `url` VARCHAR(500) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`contacto`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

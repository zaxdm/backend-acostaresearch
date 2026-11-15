CREATE TABLE `SocialDispositivo` (
  `tokenHash` CHAR(64) NOT NULL,
  `token` VARCHAR(4096) NOT NULL,
  `userId` CHAR(36) NOT NULL,
  `familyId` CHAR(36) NOT NULL,
  `sessionVersion` INTEGER NOT NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `SocialDispositivo_userId_idx` (`userId`),
  PRIMARY KEY (`tokenHash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SocialAviso` (
  `clave` CHAR(64) NOT NULL,
  `conversacionId` CHAR(36) NOT NULL,
  `canal` VARCHAR(20) NOT NULL,
  `intentos` INTEGER NOT NULL DEFAULT 0,
  `proximoAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `SocialAviso_proximoAt_idx` (`proximoAt`),
  PRIMARY KEY (`clave`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

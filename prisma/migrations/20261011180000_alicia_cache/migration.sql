CREATE TABLE `AliciaCache` (
  `clave` VARCHAR(64) NOT NULL,
  `respuesta` JSON NOT NULL,
  `en` DATETIME(3) NOT NULL,
  PRIMARY KEY (`clave`),
  INDEX `AliciaCache_en_idx` (`en`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

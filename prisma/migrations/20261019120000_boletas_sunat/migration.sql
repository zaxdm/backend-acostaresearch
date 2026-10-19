-- Boletas electrónicas de SUNAT: una fila por boleta emitida y el último
-- número de cada serie. Solo crea tablas; no toca payments ni nada existente.

-- CreateTable
CREATE TABLE `comprobantes` (
    `id` CHAR(36) NOT NULL,
    `tipo` VARCHAR(2) NOT NULL,
    `serie` VARCHAR(4) NOT NULL,
    `numero` INTEGER NOT NULL,
    `origenClave` VARCHAR(80) NOT NULL,
    `fechaEmision` DATETIME(3) NOT NULL,
    `clienteTipoDoc` VARCHAR(1) NOT NULL,
    `clienteNumDoc` VARCHAR(20) NOT NULL,
    `clienteNombre` VARCHAR(200) NOT NULL,
    `clientePais` VARCHAR(2) NULL,
    `moneda` VARCHAR(3) NOT NULL,
    `totalCents` INTEGER NOT NULL,
    `valorCents` INTEGER NOT NULL,
    `igvCents` INTEGER NOT NULL,
    `monedaOriginal` VARCHAR(3) NOT NULL,
    `importeOriginalCents` INTEGER NOT NULL,
    `tipoCambio` DECIMAL(6, 3) NULL,
    `items` JSON NOT NULL,
    `estado` ENUM('PENDIENTE', 'ACEPTADO', 'OBSERVADO', 'RECHAZADO', 'REVISAR') NOT NULL DEFAULT 'PENDIENTE',
    `intentos` INTEGER NOT NULL DEFAULT 0,
    `codigoSunat` INTEGER NULL,
    `mensaje` TEXT NULL,
    `observaciones` JSON NULL,
    `hash` VARCHAR(64) NULL,
    `xmlFirmado` MEDIUMTEXT NOT NULL,
    `cdrZip` MEDIUMBLOB NULL,
    `enviadoEn` DATETIME(3) NULL,
    `creadoEn` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actualizadoEn` DATETIME(3) NOT NULL,

    UNIQUE INDEX `comprobantes_origenClave_key`(`origenClave`),
    INDEX `comprobantes_estado_idx`(`estado`),
    INDEX `comprobantes_fechaEmision_idx`(`fechaEmision`),
    UNIQUE INDEX `comprobantes_serie_numero_key`(`serie`, `numero`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `series_comprobantes` (
    `serie` VARCHAR(4) NOT NULL,
    `ultimo` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`serie`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;


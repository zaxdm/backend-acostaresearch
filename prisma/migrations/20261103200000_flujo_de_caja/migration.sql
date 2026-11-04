-- Flujo de caja del panel (/admin → Accesos): lo que se apunta a mano.
-- Las ventas de la web y los servicios con boleta se leen de sus tablas.
--
-- Solo crea una tabla nueva: no toca las que hay. Si se revierte el código,
-- la tabla puede quedarse.

-- CreateTable
CREATE TABLE `movimientos_caja` (
    `id` CHAR(36) NOT NULL,
    `fecha` DATE NOT NULL,
    `tipo` VARCHAR(14) NOT NULL,
    `montoCents` INTEGER NOT NULL,
    `moneda` VARCHAR(3) NOT NULL DEFAULT 'PEN',
    `solesCents` INTEGER NOT NULL,
    `concepto` VARCHAR(200) NOT NULL,
    `categoria` VARCHAR(40) NULL,
    `medio` VARCHAR(40) NULL,
    `creadoPorId` CHAR(36) NULL,
    `creadoEn` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actualizadoEn` DATETIME(3) NOT NULL,

    INDEX `movimientos_caja_fecha_idx`(`fecha`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Cierres de ventas mensuales: una fila por mes terminado, con su PDF y el
-- detalle de cada venta congelados. Base para el contador y, después, SUNAT.
CREATE TABLE `cierres_mensuales` (
    `id` CHAR(36) NOT NULL,
    `anio` INTEGER NOT NULL,
    `mes` INTEGER NOT NULL,
    `ventas` INTEGER NOT NULL,
    `totalSolesCents` INTEGER NOT NULL,
    `totalesPorMoneda` JSON NOT NULL,
    `detalle` JSON NOT NULL,
    `solesPorDolar` DECIMAL(6, 3) NOT NULL,
    `pdf` MEDIUMBLOB NOT NULL,
    `creadoEn` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `cierres_mensuales_anio_mes_key`(`anio`, `mes`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Declaración mensual del 621: compras para el crédito fiscal y lo declarado
-- de cada mes. Solo crea tablas.

-- CreateTable
CREATE TABLE `compras_registradas` (
    `id` CHAR(36) NOT NULL,
    `fecha` DATE NOT NULL,
    `rucProveedor` VARCHAR(11) NOT NULL,
    `razonSocial` VARCHAR(200) NULL,
    `serie` VARCHAR(4) NOT NULL,
    `numero` INTEGER NOT NULL,
    `baseCents` INTEGER NOT NULL,
    `igvCents` INTEGER NOT NULL,
    `descripcion` VARCHAR(200) NULL,
    `origen` VARCHAR(10) NOT NULL DEFAULT 'MANUAL',
    `creadoPorId` CHAR(36) NULL,
    `creadoEn` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `compras_registradas_fecha_idx`(`fecha`),
    UNIQUE INDEX `compras_registradas_rucProveedor_serie_numero_key`(`rucProveedor`, `serie`, `numero`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `declaraciones_mensuales` (
    `id` CHAR(36) NOT NULL,
    `anio` INTEGER NOT NULL,
    `mes` INTEGER NOT NULL,
    `vencimiento` DATE NULL,
    `ajusteBaseCents` INTEGER NOT NULL DEFAULT 0,
    `ajusteNota` VARCHAR(255) NULL,
    `saldoFavorInicialCents` INTEGER NULL,
    `estado` VARCHAR(10) NOT NULL DEFAULT 'PENDIENTE',
    `numeroOrden` VARCHAR(30) NULL,
    `igvPagadoCents` INTEGER NULL,
    `rentaPagadaCents` INTEGER NULL,
    `declaradaEn` DATETIME(3) NULL,
    `calculo` JSON NULL,
    `avisoSinFechaEn` DATETIME(3) NULL,
    `avisoPrevioEn` DATETIME(3) NULL,
    `avisoUltimoEn` DATETIME(3) NULL,
    `creadoEn` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actualizadoEn` DATETIME(3) NOT NULL,

    UNIQUE INDEX `declaraciones_mensuales_anio_mes_key`(`anio`, `mes`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;


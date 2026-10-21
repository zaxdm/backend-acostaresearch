-- Servicios cobrados fuera de la web (asesorías, corrección, Turnitin,
-- estadística) que se registran en el panel para que lleven boleta con IGV.
--
-- Solo crea una tabla nueva: no toca las que hay. Si se revierte el código,
-- la tabla puede quedarse.

-- CreateTable
CREATE TABLE `servicios_registrados` (
    `id` CHAR(36) NOT NULL,
    `concepto` VARCHAR(200) NOT NULL,
    `importeCents` INTEGER NOT NULL,
    `moneda` VARCHAR(3) NOT NULL,
    `pagadoEn` DATETIME(3) NOT NULL,
    `medio` VARCHAR(40) NULL,
    `clienteTipoDoc` VARCHAR(1) NOT NULL,
    `clienteNumDoc` VARCHAR(20) NOT NULL,
    `clienteNombre` VARCHAR(200) NOT NULL,
    `clientePais` VARCHAR(2) NULL,
    `clienteEmail` VARCHAR(191) NULL,
    `nota` VARCHAR(255) NULL,
    `estado` VARCHAR(10) NOT NULL DEFAULT 'VIGENTE',
    `creadoPorId` CHAR(36) NULL,
    `creadoEn` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `servicios_registrados_pagadoEn_idx`(`pagadoEn`),
    INDEX `servicios_registrados_creadoEn_idx`(`creadoEn`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

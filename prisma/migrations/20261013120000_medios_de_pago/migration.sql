-- Lo que el dueño cambia desde el panel sobre los medios de pago de la casa
-- (Yape, Western Union, Hotmart, Culqi): apagar uno, otro titular, otro QR.
-- Una fila por medio, y solo de los que se hayan tocado: sin fila, o con un
-- campo en nulo, sigue mandando el .env. Solo añade.

-- CreateTable
CREATE TABLE `medios_de_pago` (
    `codigo` VARCHAR(20) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `titular` VARCHAR(120) NULL,
    `numero` VARCHAR(80) NULL,
    `ciudad` VARCHAR(120) NULL,
    `qrPath` VARCHAR(255) NULL,
    `qrMime` VARCHAR(40) NULL,
    `updatedById` CHAR(36) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`codigo`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

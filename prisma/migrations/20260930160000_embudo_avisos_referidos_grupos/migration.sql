-- Embudo de venta, correos según el avance del tesista, referidos y grupos
-- (cupos para universidades y asesores). Solo añade: no cambia ni borra nada.
-- Va después de la del bot de WhatsApp y no depende de ella.
-- AlterTable
ALTER TABLE `users` ADD COLUMN `avisosApagadosAt` DATETIME(3) NULL,
    ADD COLUMN `codigoReferido` VARCHAR(16) NULL;

-- AlterTable
ALTER TABLE `licenses` ADD COLUMN `grupoId` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `visitas_embudo` (
    `id` CHAR(36) NOT NULL,
    `visitante` VARCHAR(36) NOT NULL,
    `pagina` VARCHAR(40) NOT NULL,
    `dia` DATE NOT NULL,
    `userId` CHAR(36) NULL,
    `origen` VARCHAR(60) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `visitas_embudo_pagina_dia_idx`(`pagina`, `dia`),
    UNIQUE INDEX `visitas_embudo_visitante_pagina_dia_key`(`visitante`, `pagina`, `dia`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `avisos_avance` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `licenseId` CHAR(36) NULL,
    `tipo` ENUM('SIN_CONECTAR', 'SIN_AVANZAR', 'FALTA_FORMATO', 'VENCE_PRONTO') NOT NULL,
    `clave` VARCHAR(60) NOT NULL,
    `enviadoAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `avisos_avance_enviadoAt_idx`(`enviadoAt`),
    UNIQUE INDEX `avisos_avance_userId_tipo_clave_key`(`userId`, `tipo`, `clave`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `referidos` (
    `id` CHAR(36) NOT NULL,
    `invitadorId` CHAR(36) NOT NULL,
    `invitadoId` CHAR(36) NOT NULL,
    `estado` ENUM('PENDIENTE', 'PREMIADO', 'ANULADO') NOT NULL DEFAULT 'PENDIENTE',
    `paymentId` CHAR(36) NULL,
    `diasInvitador` INTEGER NOT NULL DEFAULT 0,
    `diasInvitado` INTEGER NOT NULL DEFAULT 0,
    `diasPorAplicar` INTEGER NOT NULL DEFAULT 0,
    `premiadoAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `referidos_invitadoId_key`(`invitadoId`),
    INDEX `referidos_invitadorId_idx`(`invitadorId`),
    INDEX `referidos_estado_diasPorAplicar_idx`(`estado`, `diasPorAplicar`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `grupos` (
    `id` CHAR(36) NOT NULL,
    `slug` VARCHAR(40) NOT NULL,
    `nombre` VARCHAR(120) NOT NULL,
    `productCode` VARCHAR(40) NOT NULL,
    `cupos` INTEGER NOT NULL,
    `ocupados` INTEGER NOT NULL DEFAULT 0,
    `duracionDias` INTEGER NOT NULL DEFAULT 0,
    `cierraAt` DATETIME(3) NULL,
    `activo` BOOLEAN NOT NULL DEFAULT true,
    `coordinadorId` CHAR(36) NOT NULL,
    `paymentMethod` VARCHAR(30) NOT NULL,
    `paymentRef` VARCHAR(80) NULL,
    `amountCents` INTEGER NULL,
    `paymentId` CHAR(36) NULL,
    `note` VARCHAR(255) NULL,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `grupos_slug_key`(`slug`),
    INDEX `grupos_coordinadorId_idx`(`coordinadorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `users_codigoReferido_key` ON `users`(`codigoReferido`);

-- CreateIndex
CREATE INDEX `licenses_grupoId_idx` ON `licenses`(`grupoId`);

-- AddForeignKey
ALTER TABLE `avisos_avance` ADD CONSTRAINT `avisos_avance_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `referidos` ADD CONSTRAINT `referidos_invitadorId_fkey` FOREIGN KEY (`invitadorId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `referidos` ADD CONSTRAINT `referidos_invitadoId_fkey` FOREIGN KEY (`invitadoId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `grupos` ADD CONSTRAINT `grupos_coordinadorId_fkey` FOREIGN KEY (`coordinadorId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `licenses` ADD CONSTRAINT `licenses_grupoId_fkey` FOREIGN KEY (`grupoId`) REFERENCES `grupos`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;


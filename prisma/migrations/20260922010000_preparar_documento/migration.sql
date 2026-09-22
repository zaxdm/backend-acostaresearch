-- «Preparar documento»: edición de inglés académico, traducción y resúmenes.
--
-- Lo que añade:
--   · Un tipo de plan nuevo, DOCUMENTO: la membresía de este servicio. Hasta
--     ahora solo había bolsas de palabras (WORDS) y licencias del conector
--     (LICENSE), y ninguna de las dos sabe decir «diez documentos al mes».
--   · `doc_packs`, la membresía comprada. No lleva contador: lo gastado se
--     cuenta mirando las preparaciones de la ventana en curso.
--   · `preparaciones`, cada documento mandado a preparar. Los .docx van al
--     disco, no aquí.
--   · `payments.docPackId`, para saber qué compra pagó qué membresía. Sin
--     índice único, igual que `licenseId`: la compra y cada renovación son
--     cobros distintos sobre la misma membresía.
--
-- Nada de esto toca una sola fila de lo que ya había.

-- AlterEnum
ALTER TABLE `plans` MODIFY `kind` ENUM('WORDS', 'LICENSE', 'DOCUMENTO') NOT NULL DEFAULT 'WORDS';

-- AlterTable
ALTER TABLE `plans` ADD COLUMN `docsPorMes` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `payments` ADD COLUMN `docPackId` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `doc_packs` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `planId` CHAR(36) NOT NULL,
    `docsPorMes` INTEGER NOT NULL,
    `status` ENUM('ACTIVE', 'EXPIRED', 'REVOKED') NOT NULL DEFAULT 'ACTIVE',
    `activatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `paymentMethod` VARCHAR(30) NULL,
    `paymentRef` VARCHAR(80) NULL,
    `amountCents` INTEGER NULL,
    `note` VARCHAR(255) NULL,
    `grantedById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `doc_packs_userId_status_expiresAt_idx`(`userId`, `status`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `preparaciones` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `docPackId` CHAR(36) NULL,
    `servicio` ENUM('EDICION', 'TRADUCCION', 'RESUMEN') NOT NULL,
    `idioma` VARCHAR(5) NULL,
    `nombre` VARCHAR(255) NOT NULL,
    `palabras` INTEGER NOT NULL,
    `bytes` INTEGER NOT NULL,
    `estado` ENUM('EN_COLA', 'EN_CURSO', 'LISTO', 'FALLIDO') NOT NULL DEFAULT 'EN_COLA',
    `error` VARCHAR(500) NULL,
    `tocados` INTEGER NOT NULL DEFAULT 0,
    `intactos` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `entregadoAt` DATETIME(3) NULL,

    INDEX `preparaciones_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `preparaciones_docPackId_createdAt_idx`(`docPackId`, `createdAt`),
    INDEX `preparaciones_estado_createdAt_idx`(`estado`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `payments_docPackId_idx` ON `payments`(`docPackId`);

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_docPackId_fkey` FOREIGN KEY (`docPackId`) REFERENCES `doc_packs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `doc_packs` ADD CONSTRAINT `doc_packs_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `doc_packs` ADD CONSTRAINT `doc_packs_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `plans`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `preparaciones` ADD CONSTRAINT `preparaciones_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `preparaciones` ADD CONSTRAINT `preparaciones_docPackId_fkey` FOREIGN KEY (`docPackId`) REFERENCES `doc_packs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

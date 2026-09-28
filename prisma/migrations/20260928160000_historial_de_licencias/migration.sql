-- Historial de cada licencia: cada revocación y cada reactivación, con el
-- motivo y quién. Hasta hoy solo quedaba la última revocación en la propia
-- licencia, y reactivarla la borraba.
CREATE TABLE `license_events` (
    `id` CHAR(36) NOT NULL,
    `licenseId` CHAR(36) NOT NULL,
    `tipo` ENUM('REVOCADA', 'REACTIVADA') NOT NULL,
    `origen` VARCHAR(20) NOT NULL,
    `motivo` VARCHAR(255) NULL,
    `adminId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `license_events_licenseId_createdAt_idx`(`licenseId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `license_events` ADD CONSTRAINT `license_events_licenseId_fkey` FOREIGN KEY (`licenseId`) REFERENCES `licenses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Lo que ya se sabe del pasado: la revocación vigente de cada licencia, con
-- quién la hizo deducido de su motivo, y la última reactivación.
INSERT INTO `license_events` (`id`, `licenseId`, `tipo`, `origen`, `motivo`, `createdAt`)
SELECT UUID(), `id`, 'REVOCADA',
       CASE
         WHEN `revokedReason` LIKE 'Uso compartido detectado%' THEN 'DETECTOR'
         WHEN `revokedReason` = 'Cuenta borrada por su dueño' THEN 'CUENTA_BORRADA'
         WHEN `revokedReason` = 'Producto retirado del catálogo.' THEN 'CATALOGO'
         ELSE 'ADMIN'
       END,
       `revokedReason`, `revokedAt`
FROM `licenses`
WHERE `revokedAt` IS NOT NULL;

INSERT INTO `license_events` (`id`, `licenseId`, `tipo`, `origen`, `createdAt`)
SELECT UUID(), `id`, 'REACTIVADA', 'ADMIN', `reactivatedAt`
FROM `licenses`
WHERE `reactivatedAt` IS NOT NULL;

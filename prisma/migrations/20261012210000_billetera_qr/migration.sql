-- La imagen del QR de una billetera de país: su ruta en disco y su tipo.
-- Solo añade; las billeteras que ya existen quedan sin QR.
ALTER TABLE `billeteras` ADD COLUMN `qrPath` VARCHAR(255) NULL,
    ADD COLUMN `qrMime` VARCHAR(40) NULL;

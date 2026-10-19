-- Estado del correo de cada boleta al cliente (fase 3). Solo añade columnas.

-- AlterTable
ALTER TABLE `comprobantes` ADD COLUMN `correo` VARCHAR(20) NULL,
    ADD COLUMN `correoEnviadoEn` DATETIME(3) NULL;


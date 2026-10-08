-- Revisión automática (OCR) de la captura de un pago manual.
ALTER TABLE `payments` ADD COLUMN `proofCheck` VARCHAR(255) NULL;

-- Billetera de cortesía (17-nov-2026): lo cobrado por ella se aprueba con
-- importe 0 y no cuenta como venta. Por ahora, solo Deuna.
ALTER TABLE `billeteras` ADD COLUMN `cortesia` BOOLEAN NOT NULL DEFAULT false;

UPDATE `billeteras` SET `cortesia` = true WHERE `nombre` = 'Deuna';

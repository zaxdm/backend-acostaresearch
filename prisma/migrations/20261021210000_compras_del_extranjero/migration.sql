-- Compras a proveedores del extranjero (Claude, Google, Canva…) en el crédito
-- fiscal: su IGV se paga con el Formulario 1662 y cuenta en el mes de ese pago.
--
-- Solo añade columnas con valor por defecto o nulas: las compras que ya hay
-- quedan como FACTURA y el cálculo no les cambia. Si se revierte el código,
-- las columnas pueden quedarse.

-- AlterTable
ALTER TABLE `compras_registradas`
    ADD COLUMN `tipo` VARCHAR(12) NOT NULL DEFAULT 'FACTURA',
    ADD COLUMN `documento` VARCHAR(60) NULL,
    ADD COLUMN `monedaOriginal` VARCHAR(3) NULL,
    ADD COLUMN `importeOriginalCents` INTEGER NULL,
    ADD COLUMN `tipoCambio` DECIMAL(6, 3) NULL,
    ADD COLUMN `ordenPago` VARCHAR(30) NULL,
    ADD COLUMN `igvPagadoEn` DATE NULL;

-- CreateIndex
CREATE INDEX `compras_registradas_igvPagadoEn_idx` ON `compras_registradas`(`igvPagadoEn`);

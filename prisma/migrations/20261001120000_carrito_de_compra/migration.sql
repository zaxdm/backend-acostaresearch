-- Carrito: las filas de pago que se cobran juntas comparten `cartId`.
-- Solo añade una columna que admite nulos y su índice: no cambia ni borra nada.
-- AlterTable
ALTER TABLE `payments` ADD COLUMN `cartId` CHAR(36) NULL;

-- CreateIndex
CREATE INDEX `payments_cartId_idx` ON `payments`(`cartId`);

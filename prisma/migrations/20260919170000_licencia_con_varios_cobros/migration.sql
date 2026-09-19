-- Una licencia puede tener varios cobros: la compra y cada renovación.
--
-- `payments.licenseId` era único, y una renovación —que alarga la licencia en
-- vez de emitir otra— intentaba enlazar su cobro a una licencia que ya tenía el
-- de la compra: «El registro ya existe» y la renovación no se podía aprobar.
-- No se borra ni se mueve ningún dato: solo cambia el índice.
--
-- La clave foránea se quita y se vuelve a poner porque MySQL no deja borrar el
-- índice en el que se apoya.

-- DropForeignKey
ALTER TABLE `payments` DROP FOREIGN KEY `payments_licenseId_fkey`;

-- DropIndex
DROP INDEX `payments_licenseId_key` ON `payments`;

-- CreateIndex
CREATE INDEX `payments_licenseId_idx` ON `payments`(`licenseId`);

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_licenseId_fkey` FOREIGN KEY (`licenseId`) REFERENCES `licenses`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

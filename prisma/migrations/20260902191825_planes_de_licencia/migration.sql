-- AlterTable
ALTER TABLE `payments` ADD COLUMN `licenseId` CHAR(36) NULL;

-- AlterTable
ALTER TABLE `plans` ADD COLUMN `kind` ENUM('WORDS', 'LICENSE') NOT NULL DEFAULT 'WORDS',
    ADD COLUMN `productCode` VARCHAR(40) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `payments_licenseId_key` ON `payments`(`licenseId`);

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_licenseId_fkey` FOREIGN KEY (`licenseId`) REFERENCES `licenses`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;


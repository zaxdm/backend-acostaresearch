-- AlterTable
ALTER TABLE `activation_codes` ADD COLUMN `proofMime` VARCHAR(40) NULL,
    ADD COLUMN `proofPath` VARCHAR(255) NULL;

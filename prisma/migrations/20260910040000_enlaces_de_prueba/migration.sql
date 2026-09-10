-- Enlaces de prueba del conector.
--
-- El administrador crea un enlace para un grupo y cada persona que lo abre
-- recibe su propio conector, sin registrarse, hasta agotar los cupos. Cada
-- invitado es un usuario de relleno —sin contraseña, con un correo que no
-- existe— porque la licencia y el proyecto de tesis cuelgan de un usuario, y
-- con uno solo para todos los treinta escribirían en la misma tesis.
--
-- En cascada: borrar el enlace se lleva a sus invitados y, con ellos, sus
-- licencias y proyectos. Ninguna cuenta real tiene `trialLinkId`, así que
-- ninguna puede caer por aquí.

-- AlterTable
ALTER TABLE `users` ADD COLUMN `trialLinkId` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `trial_links` (
    `id` CHAR(36) NOT NULL,
    `slug` VARCHAR(40) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `productCode` VARCHAR(40) NOT NULL,
    `seats` INTEGER NOT NULL DEFAULT 30,
    `claimed` INTEGER NOT NULL DEFAULT 0,
    `accessDays` INTEGER NOT NULL,
    `callsPerDay` INTEGER NOT NULL DEFAULT 0,
    `callsLimitTotal` INTEGER NOT NULL DEFAULT 0,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `trial_links_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `users_trialLinkId_idx` ON `users`(`trialLinkId`);

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_trialLinkId_fkey` FOREIGN KEY (`trialLinkId`) REFERENCES `trial_links`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

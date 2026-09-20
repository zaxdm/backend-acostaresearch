-- Los asesores del piloto no se postulan: se les llama y el administrador los
-- da de alta. Por eso la convocatoria pasa a ser opcional: colgarlos de una
-- inventada sería escribir en la base una historia que no ocurrió.

ALTER TABLE `asesores` DROP FOREIGN KEY `asesores_convocatoriaId_fkey`;

ALTER TABLE `asesores` MODIFY COLUMN `convocatoriaId` CHAR(36) NULL;

ALTER TABLE `asesores` ADD CONSTRAINT `asesores_convocatoriaId_fkey` FOREIGN KEY (`convocatoriaId`) REFERENCES `convocatorias`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

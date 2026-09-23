-- Varias reseñas por cuenta, y reseñas sin cuenta detrás.
--
-- VARIAS POR CUENTA: se cae el índice único sobre `userId`. Quien vuelve a los
-- seis meses con otra fase terminada tiene algo distinto que contar, y hasta
-- ahora escribir la segunda borraba la primera.
--
-- SIN CUENTA: `userId` pasa a admitir nulo. El panel da de alta testimonios que
-- llegan por WhatsApp, y algunos son de gente que compró por otra vía y no
-- tiene cuenta en la web. Antes eso no se podía guardar; ahora sí, avisando.
--
-- `correo` guarda con qué se firma —siempre tapado al enseñarlo—, para que una
-- reseña sin cuenta siga teniendo firma. Se rellena con el de la cuenta en las
-- que ya existen.
--
-- `delPanel` marca las que escribió el panel a nombre de otro: su titular no
-- las puede tocar, porque no las escribió él.
--
-- La clave ajena se suelta y se vuelve a poner: MySQL no deja tocar el índice
-- ni el tipo de una columna mientras la sostiene.

ALTER TABLE `resenas_servicio` DROP FOREIGN KEY `resenas_servicio_userId_fkey`;
ALTER TABLE `resenas_servicio` DROP INDEX `resenas_servicio_userId_key`;
ALTER TABLE `resenas_servicio` MODIFY COLUMN `userId` CHAR(36) NULL;

ALTER TABLE `resenas_servicio`
    ADD COLUMN `correo` VARCHAR(200) NOT NULL DEFAULT '',
    ADD COLUMN `delPanel` BOOLEAN NOT NULL DEFAULT false;

-- Las que ya están firmadas por una cuenta se quedan con su correo.
UPDATE `resenas_servicio` `r`
    JOIN `users` `u` ON `u`.`id` = `r`.`userId`
    SET `r`.`correo` = `u`.`email`;

CREATE INDEX `resenas_servicio_userId_idx` ON `resenas_servicio`(`userId`);

ALTER TABLE `resenas_servicio`
    ADD CONSTRAINT `resenas_servicio_userId_fkey` FOREIGN KEY (`userId`)
    REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

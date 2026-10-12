-- Administradores de país: un rol nuevo y la etiqueta de país en la cuenta, en
-- los códigos de activación, en los descuentos y en los enlaces de prueba.
-- Solo añade: lo que ya existe queda con `pais` nulo, que es «de la casa».
ALTER TABLE `users` MODIFY `role` ENUM('USER', 'EDITOR', 'ADMIN', 'ADMIN_PAIS') NOT NULL DEFAULT 'USER';
ALTER TABLE `users` ADD COLUMN `pais` VARCHAR(2) NULL;
ALTER TABLE `activation_codes` ADD COLUMN `pais` VARCHAR(2) NULL;
ALTER TABLE `discount_codes` ADD COLUMN `pais` VARCHAR(2) NULL;
ALTER TABLE `trial_links` ADD COLUMN `pais` VARCHAR(2) NULL;

CREATE INDEX `users_pais_idx` ON `users`(`pais`);
CREATE INDEX `activation_codes_pais_idx` ON `activation_codes`(`pais`);

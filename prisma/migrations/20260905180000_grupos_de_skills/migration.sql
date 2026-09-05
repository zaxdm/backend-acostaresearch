-- Grupos de skills.
--
-- Un grupo es un producto vendible: «método de tesis», «humanizar texto». El
-- valor de esta columna es el `productCode` del plan que lo vende, el mismo que
-- lleva cada licencia, para que el conector solo sirva los capítulos del grupo
-- que el comprador pagó.
--
-- Nulo = visible para cualquier licencia. Es la red de seguridad para una skill
-- subida sin elegir grupo: es más fácil notar un capítulo que se ve de más que
-- uno que no se ve.
ALTER TABLE `skills` ADD COLUMN `productCode` VARCHAR(40) NULL;

CREATE INDEX `skills_productCode_idx` ON `skills`(`productCode`);

-- Un capítulo puede estar en varios grupos.
--
-- `skills.productCode` era una sola columna: un capítulo pertenecía a un grupo
-- y solo a uno. Marcarlo en otro grupo desde el panel lo sacaba del primero sin
-- decir nada, y el grupo de al lado se quedaba sin ese capítulo. Pero «Tema y
-- delimitación» es el primer capítulo del método de tesis Y del pack con
-- humanizador: son productos distintos que comparten contenido.
--
-- La pertenencia pasa a una tabla aparte. Sin filas = visible para cualquier
-- licencia, que es la misma red de seguridad que daba el NULL de la columna.
CREATE TABLE `skill_groups` (
  `skillId` CHAR(36) NOT NULL,
  `productCode` VARCHAR(40) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `skill_groups_productCode_idx`(`productCode`),
  PRIMARY KEY (`skillId`, `productCode`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Lo que ya había: cada capítulo con grupo entra con su grupo. Los que estaban
-- a NULL no generan fila, y siguen viéndose desde cualquier licencia.
INSERT INTO `skill_groups` (`skillId`, `productCode`)
SELECT `id`, `productCode` FROM `skills` WHERE `productCode` IS NOT NULL;

ALTER TABLE `skill_groups`
  ADD CONSTRAINT `skill_groups_skillId_fkey`
  FOREIGN KEY (`skillId`) REFERENCES `skills`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX `skills_productCode_idx` ON `skills`;
ALTER TABLE `skills` DROP COLUMN `productCode`;

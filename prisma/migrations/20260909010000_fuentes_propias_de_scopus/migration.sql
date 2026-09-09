-- Fuentes propias: lo que cada comprador sube de su export de Scopus.
--
-- El orden importa y no es intercambiable. Primero se abre `zoteroKey` a nulo,
-- porque lo importado no viene de Zotero y no tiene clave que traer; el índice
-- único se queda tal cual, ya que MySQL admite tantos nulos como haga falta en
-- un índice único y sigue impidiendo dos filas con la MISMA clave.
--
-- Las filas que ya existen no se tocan: todas son del fondo de la casa, que es
-- justo lo que significan `ownerUserId` nulo y `origin` en ZOTERO. Por eso los
-- valores por defecto son los correctos y no hace falta rellenar nada a mano ni
-- volver a sincronizar la biblioteca.

ALTER TABLE `references` MODIFY `zoteroKey` VARCHAR(16) NULL;

ALTER TABLE `references`
  ADD COLUMN `ownerUserId` CHAR(36) NULL,
  ADD COLUMN `origin` ENUM('ZOTERO', 'SCOPUS') NOT NULL DEFAULT 'ZOTERO',
  ADD COLUMN `sourceRef` VARCHAR(200) NULL;

-- La identidad de una fuente importada es el par dueño + referencia. Volver a
-- subir el mismo export no crea una segunda copia de nada.
--
-- Las filas de la casa llevan los dos campos nulos, y MySQL considera distintos
-- dos nulos, así que este índice no las estorba: siguen identificándose por
-- `zoteroKey`.
CREATE UNIQUE INDEX `references_ownerUserId_sourceRef_key`
  ON `references` (`ownerUserId`, `sourceRef`);

-- Toda búsqueda de un comprador filtra por esta columna, y es el filtro que no
-- puede fallar: sin índice, cada consulta del conector recorre la tabla entera.
CREATE INDEX `references_ownerUserId_idx` ON `references` (`ownerUserId`);

-- Borrar la cuenta se lleva sus fuentes. Son suyas: las descargó él con la
-- suscripción de su universidad y no tienen por qué sobrevivirle.
ALTER TABLE `references`
  ADD CONSTRAINT `references_ownerUserId_fkey`
  FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

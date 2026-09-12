-- La norma de citas del Word.
--
-- Hasta ahora el Word de la tesis salía siempre en APA 7, escrita a mano en el
-- servidor. Un tesista cuya universidad pide Vancouver, IEEE o Chicago tenía que
-- rehacer a mano todas las citas y la lista de referencias después de
-- descargarlo, que es justo el trabajo que esta plataforma existe para ahorrar.
--
-- Ahora cada proyecto guarda su norma —uno de los quince estilos que trae Zotero
-- de fábrica, ver `project.normas`— y el idioma de las citas. El Word se arma
-- con esa norma usando el mismo motor que Zotero.
--
-- Nulos en todo lo que ya existe, y nulo significa APA 7 en español: el Word de
-- los proyectos que ya estaban sigue saliendo como salía.

ALTER TABLE `projects`
  ADD COLUMN `estiloCitas` VARCHAR(64) NULL,
  ADD COLUMN `idiomaCitas` VARCHAR(8) NULL;

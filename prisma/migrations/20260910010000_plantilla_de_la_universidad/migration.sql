-- La plantilla de la universidad del tesista.
--
-- Aquí solo va la marca de que existe y cómo se llamaba el archivo. La hoja de
-- estilos vive en disco, junto a los capítulos, por lo mismo que ellos: esta
-- base va en un plan compartido y no es sitio para archivos.
--
-- Del .docx que sube el tesista NO se guarda el contenido, solo `word/styles.xml`.
-- Una plantilla de facultad suele venir con ejemplos dentro, a veces con el
-- nombre de otro tesista, a veces con una tesis entera. Nada de eso hace falta,
-- y lo que no se guarda no se puede filtrar.

ALTER TABLE `projects`
  ADD COLUMN `plantillaAt` DATETIME(3) NULL,
  ADD COLUMN `plantillaNombre` VARCHAR(200) NULL;

-- Cuánto lleva escrito de cada capítulo.
--
-- El texto NO entra en la base de datos, y no es una preferencia: esta base va
-- en el plan Dev de un proveedor compartido y ya pesa 171 MB, de los cuales 170
-- son el corpus bibliográfico. Una tesis completa ronda el medio mega, así que
-- doscientos tesistas serían cien megas más encima de lo que ya hay, y además
-- engordarían el volcado del respaldo todos los días.
--
-- El texto vive en disco, junto a los comprobantes y los bundles, donde hay 34
-- GB libres y donde el respaldo diario ya llega. Aquí queda solo lo justo para
-- pintar el panel sin tener que abrir un archivo por capítulo.

ALTER TABLE `project_stages`
  ADD COLUMN `palabras` INT NOT NULL DEFAULT 0,
  ADD COLUMN `textoAt` DATETIME(3) NULL;

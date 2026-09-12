-- Volumen, número y páginas: lo que le faltaba a la bibliografía.
--
-- Hasta ahora una entrada de referencias salía así:
--
--   Autores (2024). Título del artículo. Revista de Educación. https://doi.org/…
--
-- y APA 7 la pide así:
--
--   Autores (2024). Título del artículo. Revista de Educación, 15(2), 45-62. https://…
--
-- No era un fallo de formato: los tres campos no existían en esta tabla y
-- ninguna de las cuatro vías de entrada los leía, aunque Zotero y los exports
-- de Scopus, Web of Science y PubMed los traen. Es de lo primero que mira un
-- asesor en la lista de referencias.
--
-- Texto y no enteros: un volumen puede ser «15A», un número «S1» y las páginas
-- de un artículo electrónico «e0123456».
--
-- Nulos en todo lo que ya está guardado. No se puede rellenar con una migración
-- —el dato no está en ninguna columna— sino volviendo a pasar por el origen:
-- la sincronización nocturna del corpus los irá completando, y lo que venga
-- solo con DOI se completa contra Crossref.

ALTER TABLE `references`
  ADD COLUMN `volume` VARCHAR(40) NULL,
  ADD COLUMN `issue` VARCHAR(40) NULL,
  ADD COLUMN `pages` VARCHAR(40) NULL;

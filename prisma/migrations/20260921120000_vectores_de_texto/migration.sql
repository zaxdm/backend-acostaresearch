-- Los vectores de la búsqueda por significado, guardados para siempre.
--
-- El vector de un artículo no cambia nunca, pero se recordaba solo en memoria y
-- cada reinicio lo tiraba. Aquí se calcula una vez para todos los tesistas: la
-- clave es el hash del texto, así que no lleva usuario ni se borra con ninguno.

CREATE TABLE `vectores_de_texto` (
    `clave` CHAR(64) NOT NULL,
    `modelo` VARCHAR(80) NOT NULL,
    `vector` BLOB NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`clave`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

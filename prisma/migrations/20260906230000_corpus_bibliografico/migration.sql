-- Corpus bibliográfico: espejo de solo lectura de la biblioteca de Zotero.

CREATE TABLE `references` (
    `id` CHAR(36) NOT NULL,
    `zoteroKey` VARCHAR(16) NOT NULL,
    `version` INTEGER NOT NULL,
    `itemType` VARCHAR(40) NOT NULL,
    `title` VARCHAR(500) NOT NULL,
    `authors` VARCHAR(500) NOT NULL,
    `year` INTEGER NULL,
    `source` VARCHAR(300) NULL,
    `doi` VARCHAR(200) NULL,
    `url` VARCHAR(500) NULL,
    `abstract` TEXT NULL,
    `notes` TEXT NULL,
    `tags` VARCHAR(500) NOT NULL DEFAULT '',
    `busqueda` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `references_zoteroKey_key`(`zoteroKey`),
    INDEX `references_year_idx`(`year`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `reference_groups` (
    `referenceId` CHAR(36) NOT NULL,
    `productCode` VARCHAR(40) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `reference_groups_productCode_idx`(`productCode`),
    PRIMARY KEY (`referenceId`, `productCode`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `reference_sync` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `libraryVersion` INTEGER NOT NULL DEFAULT 0,
    `lastRunAt` DATETIME(3) NULL,
    `lastCount` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `reference_groups` ADD CONSTRAINT `reference_groups_referenceId_fkey`
    FOREIGN KEY (`referenceId`) REFERENCES `references`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Índice de texto completo sobre la columna de búsqueda.
--
-- Con 24.000 fuentes —y creciendo cada vez que se exporta una búsqueda de
-- Scopus— un LIKE recorre la tabla entera en CADA pregunta que hace un tesista
-- desde Claude. El índice lo convierte en una consulta constante.
--
-- No está declarado en schema.prisma porque los índices de texto completo
-- siguen tras una bandera de vista previa en Prisma. `migrate deploy` no lo
-- toca; solo hay que recordarlo si algún día se regenera esta tabla.
ALTER TABLE `references` ADD FULLTEXT INDEX `references_busqueda_ft` (`busqueda`);

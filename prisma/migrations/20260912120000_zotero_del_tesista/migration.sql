-- El Zotero de cada tesista.
--
-- Hasta ahora Zotero era UNA biblioteca: la de la casa, con una clave que vive
-- en el `.env` y un marcador de versión en `reference_sync`, que es una fila
-- única. Esto añade una biblioteca POR PERSONA, y por eso no puede reutilizar
-- aquel marcador: dos tesistas sincronizando se pisarían la versión el uno al
-- otro y cada pasada se dejaría fuera lo que trajo la anterior.
--
-- LO QUE NO HACE FALTA TOCAR, Y POR QUÉ
-- ------------------------------------
-- `references.zoteroKey` es ÚNICA EN TODA LA TABLA, y las claves de ítem de
-- Zotero solo son únicas dentro de su biblioteca: dos bibliotecas distintas
-- pueden traer la misma. Parecía obligar a romper ese índice, que es el que usa
-- el `ON DUPLICATE KEY UPDATE` del corpus.
--
-- No hace falta, porque las fuentes de un tesista NO entran por ahí: entran por
-- el mismo camino que su export de Scopus, identificadas por
-- (`ownerUserId`, `sourceRef`), con `sourceRef` = «zotero:users/<id>:<clave>» y
-- `zoteroKey` nula. Así la biblioteca de un tesista no puede colisionar con el
-- corpus ni con la de otro, y el índice del corpus se queda como estaba.

-- CreateTable
CREATE TABLE `zotero_accounts` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `zoteroUserId` VARCHAR(32) NOT NULL,
    `username` VARCHAR(120) NULL,
    -- Cifrada con AES-256-GCM. Ver `shared/utils/secretos.js`.
    `apiKeyCipher` VARCHAR(500) NOT NULL,
    `collectionKey` VARCHAR(16) NULL,
    `collectionName` VARCHAR(200) NULL,
    `libraryVersion` INTEGER NOT NULL DEFAULT 0,
    `lastRunAt` DATETIME(3) NULL,
    `lastCount` INTEGER NOT NULL DEFAULT 0,
    -- Cerrojo por persona: dos tesistas sincronizan a la vez sin estorbarse.
    `runningSince` DATETIME(3) NULL,
    `lastError` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `zotero_accounts_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
--
-- El pagaré de un OAuth a medias. El segundo paso de OAuth 1.0a ocurre fuera
-- —el tesista se va a zotero.org— y al volver trae el token, pero el secreto
-- con el que se canjea se generó antes y hay que haberlo guardado.
--
-- Guarda también de quién es: el que vuelve llega desde otro dominio y puede no
-- traer sesión, así que la identidad se saca de aquí y no de la cookie.
CREATE TABLE `zotero_oauth_requests` (
    `token` VARCHAR(64) NOT NULL,
    `secretCipher` VARCHAR(500) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `zotero_oauth_requests_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`token`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `zotero_accounts` ADD CONSTRAINT `zotero_accounts_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

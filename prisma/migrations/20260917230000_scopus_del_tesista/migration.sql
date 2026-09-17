-- La conexión de cada tesista con Scopus.
--
-- Dos tablas, gemelas de las que ya existen para Zotero: una para la conexión
-- y otra para el intercambio a medias. No se reaprovechan aquellas porque no
-- son la misma cosa —Zotero es OAuth 1.0a y devuelve una clave de API que no
-- caduca; esto es OAuth 2 con tokens que sí— y un par de columnas nulas para
-- cada caso acabaría con una tabla que no se entiende sin leer el código.
--
-- LO QUE NO SE TOCA, Y POR QUÉ
-- ---------------------------
-- `references` se queda como está. Las fuentes que lleguen por la API de
-- Scopus son, para esta base, exactamente lo mismo que las que llegan por un
-- export de Scopus: mismo `origin` (SCOPUS), misma identidad (`sourceRef` =
-- «doi:…» o «eid:…»), mismo dueño. Esa igualdad no es descuido: es lo que
-- hace que el artículo que el tesista importó ayer por API y que hoy vuelve a
-- subir dentro de un CSV sea UNA fila y no dos.
--
-- Añadir un valor SCOPUS_API al enum `ReferenceOrigin` habría obligado a
-- revisar `filtroDeOrigen`, el enum del conector, el rótulo de `mis_fuentes` y
-- la dedup, todo para distinguir dos cosas que al tesista le da igual
-- distinguir: la fuente es la misma y la licencia de Elsevier también.

-- CreateTable
CREATE TABLE `scopus_connections` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    -- APIKEY = con la clave de la casa, que es lo único que Elsevier da por
    -- autoservicio. OAUTH = con tokens del propio tesista, cuando Elsevier
    -- habilite el flujo para esta aplicación.
    `mode` ENUM('APIKEY', 'OAUTH') NOT NULL DEFAULT 'APIKEY',
    `scopusUserId` VARCHAR(64) NULL,
    `scopusName` VARCHAR(200) NULL,
    -- Cifrados con AES-256-GCM. Ver `shared/utils/secretos.js`. Nulos en el
    -- modo APIKEY, que no tiene tokens que guardar.
    `accessTokenCipher` VARCHAR(2000) NULL,
    `refreshTokenCipher` VARCHAR(2000) NULL,
    `expiresAt` DATETIME(3) NULL,
    `status` ENUM('ACTIVA', 'CADUCADA', 'REVOCADA') NOT NULL DEFAULT 'ACTIVA',
    `lastError` VARCHAR(500) NULL,
    `lastSearchAt` DATETIME(3) NULL,
    `imported` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `scopus_connections_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
--
-- El pagaré de un OAuth a medias. Guarda el verificador de PKCE, que es lo que
-- hace que el código que vuelve por la barra de direcciones no sirva de nada a
-- quien lo copie: el verificador nunca salió de este servidor.
--
-- Guarda también de quién es el intercambio, porque el que vuelve llega desde
-- otro dominio y su cookie de sesión puede no viajar.
CREATE TABLE `scopus_oauth_states` (
    `state` VARCHAR(64) NOT NULL,
    `verifierCipher` VARCHAR(500) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `scopus_oauth_states_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`state`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `scopus_connections` ADD CONSTRAINT `scopus_connections_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

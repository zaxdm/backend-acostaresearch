-- El Libro de Reclamaciones virtual.
--
-- El número de hoja es la clave primaria y autoincremental a propósito: el
-- reglamento pide un correlativo, y que lo dé la base es la única forma de que
-- dos hojas presentadas en el mismo segundo no reciban el mismo número.
--
-- Sin clave foránea a `users`: una hoja no es de una cuenta —la presenta
-- cualquiera, con cuenta o sin ella— y borrar una cuenta no puede llevársela.
-- `respondidoPorId` tampoco la tiene, por lo mismo: si un administrador se da
-- de baja, lo que contestó sigue escrito.

-- CreateTable
CREATE TABLE `reclamos` (
    `numero` INTEGER NOT NULL AUTO_INCREMENT,
    `tipo` ENUM('RECLAMO', 'QUEJA') NOT NULL,
    `nombre` VARCHAR(160) NOT NULL,
    `tipoDocumento` ENUM('DNI', 'CE', 'PASAPORTE') NOT NULL,
    `numeroDocumento` VARCHAR(20) NOT NULL,
    `domicilio` VARCHAR(250) NOT NULL,
    `telefono` VARCHAR(20) NULL,
    `email` VARCHAR(255) NOT NULL,
    `apoderado` VARCHAR(160) NULL,
    `tipoBien` ENUM('PRODUCTO', 'SERVICIO') NOT NULL,
    `montoReclamado` DECIMAL(10, 2) NULL,
    `descripcionBien` VARCHAR(500) NOT NULL,
    `detalle` TEXT NOT NULL,
    `pedido` TEXT NOT NULL,
    `fechaLimite` DATETIME(3) NOT NULL,
    `respuesta` TEXT NULL,
    `respondidoAt` DATETIME(3) NULL,
    `respondidoPorId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `reclamos_respondidoAt_idx`(`respondidoAt`),
    PRIMARY KEY (`numero`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

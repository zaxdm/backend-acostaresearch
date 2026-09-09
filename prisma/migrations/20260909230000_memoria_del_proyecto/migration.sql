-- La memoria del proyecto.
--
-- Hasta ahora el conector respondía y olvidaba. Cada conversación empezaba de
-- cero: el tesista volvía a contar su tema, sus objetivos y su metodología, y
-- si abría un chat nuevo había perdido el hilo. De aquí cuelga todo lo demás
-- que falta —el Word, las citas automáticas, la revisión final—, porque ninguna
-- de esas cosas se puede construir sobre respuestas sueltas.
--
-- Nada de esto cambia lo que ya funciona. Las tablas nacen vacías, ninguna
-- columna existente se toca, y una licencia sin proyecto se comporta
-- exactamente igual que ayer.

CREATE TABLE `projects` (
  `id`          CHAR(36)     NOT NULL,
  `userId`      CHAR(36)     NOT NULL,
  `productCode` VARCHAR(40)  NOT NULL,
  `tema`        VARCHAR(500) NULL,
  `carrera`     VARCHAR(160) NULL,
  `universidad` VARCHAR(160) NULL,
  `createdAt`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`   DATETIME(3)  NOT NULL,

  PRIMARY KEY (`id`),
  -- Un proyecto por comprador y método. Un tesista tiene UNA tesis; permitir
  -- dos es la forma más rápida de que alguien escriba el capítulo IV de la que
  -- no era. Si además compra la ruta del artículo, eso es otra fila.
  UNIQUE INDEX `projects_userId_productCode_key` (`userId`, `productCode`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `project_stages` (
  `id`        CHAR(36)    NOT NULL,
  `projectId` CHAR(36)    NOT NULL,
  -- La clave del capítulo, la misma que usa `redactar`. No es clave foránea
  -- contra `skills` a propósito: retirar un capítulo del catálogo no puede
  -- borrar el avance de nadie.
  `skillCode` VARCHAR(64) NOT NULL,
  `estado`    ENUM('PENDIENTE', 'EN_CURSO', 'LISTO') NOT NULL DEFAULT 'PENDIENTE',
  `resumen`   TEXT        NULL,
  `datos`     JSON        NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `project_stages_projectId_skillCode_key` (`projectId`, `skillCode`),
  INDEX `project_stages_projectId_estado_idx` (`projectId`, `estado`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Borrar la cuenta se lleva su proyecto. Es suyo, y sin él las etapas no
-- significan nada.
ALTER TABLE `projects`
  ADD CONSTRAINT `projects_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `project_stages`
  ADD CONSTRAINT `project_stages_projectId_fkey`
  FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

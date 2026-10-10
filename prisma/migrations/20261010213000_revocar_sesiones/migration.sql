ALTER TABLE `users` ADD COLUMN `sessionVersion` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `refresh_tokens` ADD COLUMN `sessionVersion` INTEGER NOT NULL DEFAULT 0;

-- Incluye cambios desde la aplicación y desde herramientas administrativas.
CREATE TRIGGER `users_session_version` BEFORE UPDATE ON `users`
FOR EACH ROW SET NEW.sessionVersion = IF(
  NOT (NEW.role <=> OLD.role) OR NOT (NEW.status <=> OLD.status),
  OLD.sessionVersion + 1,
  NEW.sessionVersion
);

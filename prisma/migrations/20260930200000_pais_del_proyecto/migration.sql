-- El país donde estudia, para adaptar el método (perfil España: TFG y TFM).
-- Solo añade una columna que admite nulos: no cambia ni borra nada.
-- AlterTable
ALTER TABLE `projects` ADD COLUMN `pais` VARCHAR(2) NULL;

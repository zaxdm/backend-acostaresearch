-- «Edición y Traducción» suma un tercer servicio: humanizar el Word.
--
-- Solo añade un valor a la lista. Ninguna fila cambia, y si se revierte el
-- código el valor puede quedarse: nadie más lo usa.

-- AlterEnum
ALTER TABLE `preparaciones` MODIFY `servicio` ENUM('EDICION', 'TRADUCCION', 'RESUMEN', 'HUMANIZAR') NOT NULL;

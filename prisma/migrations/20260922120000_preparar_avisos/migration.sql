-- Por qué un párrafo se quedó sin traducir.
--
-- Hasta ahora de cada preparación se guardaba solo CUÁNTOS párrafos quedaron
-- intactos, y la web rellenaba el motivo a mano con una frase fija: «llevaban
-- dentro una nota al pie, una ecuación o una imagen». Esa frase salía igual
-- pasara lo que pasara, incluso en documentos sin una sola nota al pie, y el
-- cliente no podía arreglar lo que no sabía que había pasado.
--
-- `avisos` guarda los motivos de verdad, agrupados por motivo y por parte del
-- documento, como JSON: [{ donde, motivo, cuantos, ejemplo }].
--
-- Nulo en todo lo que ya estaba entregado: de aquellas preparaciones no se
-- guardó el motivo y no hay de dónde sacarlo. La web enseña el número, como
-- hasta ahora, y nada más.

-- AlterTable
ALTER TABLE `preparaciones` ADD COLUMN `avisos` TEXT NULL;

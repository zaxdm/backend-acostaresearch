-- La clave con la que se cita una fuente.
--
-- Hasta ahora el asistente recibía la ficha en APA ya montada y la pegaba en el
-- texto. Eso funciona hasta que hay que rehacer la bibliografía: no queda rastro
-- de QUÉ fuente se citó, solo de cómo quedó escrita, y una cita mal copiada es
-- indistinguible de una bien copiada.
--
-- Con una clave corta, el asistente escribe [AR97D22F86] donde va la cita y el
-- servidor la resuelve al armar el Word: la cita en el texto y la entrada en
-- Referencias salen del MISMO registro, así que no pueden discrepar.
--
-- ES UNA COLUMNA CALCULADA, y eso es lo que la hace fiable. Se deriva del
-- identificador de la propia fila, así que ninguna de las dos vías de entrada
-- —la sincronización de Zotero y el export que sube un comprador— tiene que
-- acordarse de rellenarla, ni ahora ni cuando alguien añada una tercera. Y como
-- depende solo de `id`, que no cambia nunca, la clave de una fuente es la misma
-- para siempre: una tesis citada el año pasado sigue resolviendo igual.

ALTER TABLE `references`
  ADD COLUMN `ref` VARCHAR(12)
  AS (CONCAT('AR', UPPER(SUBSTRING(SHA1(`id`), 1, 8)))) STORED;

-- Ocho caracteres hexadecimales son cuatro mil millones de combinaciones para
-- veinticuatro mil fuentes. El índice único no está por si acaso: está para que
-- una colisión, si algún día la hubiera, salte aquí y no dentro de la
-- bibliografía de alguien.
CREATE UNIQUE INDEX `references_ref_key` ON `references` (`ref`);

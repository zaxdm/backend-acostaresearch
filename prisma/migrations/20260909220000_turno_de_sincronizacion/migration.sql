-- Cerrojo de la sincronización de Zotero, compartido entre procesos.
--
-- Hasta ahora el único guardia era una variable en memoria del proceso web.
-- Servía mientras la sincronización se lanzaba solo desde el panel; deja de
-- servir en cuanto la lanza también una tarea programada desde otro proceso,
-- porque cada uno tiene su propia variable y ninguno ve la del otro.
--
-- Esto importa por una razón concreta: el plan de la base de datos da CINCO
-- conexiones. Ya se agotaron dos veces, y una de ellas fue exactamente esto,
-- dos trabajos pesados a la vez. La columna se toma con un UPDATE condicional,
-- que en MySQL es atómico: el segundo proceso ve cero filas afectadas y se
-- retira sin hacer nada.
--
-- Nula significa que no hay nadie dentro. Se guarda el instante de entrada y no
-- un booleano para poder soltar un cerrojo que quedó puesto: si el proceso muere
-- a media pasada, nadie lo suelta, y sin la hora no habría forma de distinguir
-- "hay una sincronización en marcha" de "hubo una que se murió en marzo".

ALTER TABLE `reference_sync` ADD COLUMN `runningSince` DATETIME(3) NULL;

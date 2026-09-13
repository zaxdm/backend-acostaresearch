-- La fecha en que el administrador reactivó una licencia.
--
-- La vigilancia de licencias compartidas no juzga nada anterior a esta fecha:
-- ni el uso, ni las alertas, ni el aviso previo. Sin ella el botón «Reactivar»
-- no servía: la siguiente pasada volvía a ver las mismas conversaciones que la
-- revocaron —seguían dentro de la ventana de 24 horas— y un aviso de días
-- atrás, y la revocaba otra vez en cuanto se usaba. Pasó el 13 de septiembre
-- de 2026.
--
-- ES ADITIVA: una columna nula nueva. El código que sigue corriendo durante el
-- despliegue no la conoce y no la necesita.

ALTER TABLE `licenses` ADD COLUMN `reactivatedAt` DATETIME(3) NULL;

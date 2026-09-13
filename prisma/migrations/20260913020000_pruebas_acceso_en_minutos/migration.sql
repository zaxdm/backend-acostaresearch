-- El tiempo de acceso de los enlaces de prueba pasa de días a minutos.
--
-- Una prueba de un taller o de un directo dura horas, no días, y con días el
-- mínimo era 24 horas. Ahora se da en minutos (el panel deja elegir minutos u
-- horas), y 0 significa sin límite: el conector no caduca.
--
-- ES ADITIVA A PROPÓSITO. Se añade la columna nueva y la vieja se queda sin
-- leerse. Renombrarla haría que el código que sigue corriendo durante el
-- despliegue —entre esta migración y el reinicio— pidiera una columna que ya no
-- existe, y fallarían los enlaces justo en ese momento.
--
-- Los enlaces que ya existen conservan su duración: sus días pasan a minutos
-- (1 día = 1440). Las licencias de los invitados que ya recogieron su conector
-- no se tocan: su fecha de caducidad se calculó al recogerlo y está en su
-- licencia.

ALTER TABLE `trial_links` ADD COLUMN `accessMinutes` INTEGER NOT NULL DEFAULT 0;

UPDATE `trial_links` SET `accessMinutes` = `accessDays` * 1440;

ALTER TABLE `trial_links` ALTER COLUMN `accessDays` SET DEFAULT 0;

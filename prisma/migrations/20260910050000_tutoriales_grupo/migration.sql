-- Los tutoriales se agrupan («Para empezar», «Una por Skill») y pueden llevar
-- una etiqueta corta en lugar de su número («S4»). Vacío en los dos = como
-- hasta ahora, así que los videos que ya hay no cambian.

ALTER TABLE `tutorials`
    ADD COLUMN `grupo` VARCHAR(60) NOT NULL DEFAULT '',
    ADD COLUMN `etiqueta` VARCHAR(8) NOT NULL DEFAULT '';

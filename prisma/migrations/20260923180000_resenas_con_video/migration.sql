-- El video del testimonio.
--
-- Solo el peso y el tipo van a la base; el archivo vive en disco, colgado de
-- donde estén los comprobantes, igual que los capítulos y los PDF de las guías.
-- Un video de un minuto son decenas de megas y la base ya carga con el corpus
-- bibliográfico: meterlo aquí sería pagar dos veces por lo mismo.
--
-- `videoBytes` = 0 significa que no hay video, y es lo único que hay que mirar.
-- El tipo se guarda tal cual se detectó al subirlo para poder servirlo sin
-- adivinarlo después.
ALTER TABLE `resenas_servicio`
    ADD COLUMN `videoBytes` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `videoTipo` VARCHAR(60) NOT NULL DEFAULT '';

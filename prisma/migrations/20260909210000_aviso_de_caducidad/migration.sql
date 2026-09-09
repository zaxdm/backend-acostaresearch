-- Aviso de caducidad: la marca que impide mandarle el mismo correo dos veces
-- al mismo comprador.
--
-- Se guarda la fecha y no un booleano a propósito. Meses después, cuando
-- alguien pregunte por qué no se enteró de que su acceso caducaba, la
-- diferencia entre "se le avisó" y "se le avisó el día antes" es toda la
-- respuesta.
--
-- Las 25 licencias que ya existen quedan con la columna nula, que es lo
-- correcto: a ninguna se le ha avisado todavía. La primera pasada del aviso
-- diario las recogerá a las que les toque por fecha.

ALTER TABLE `licenses` ADD COLUMN `expiryWarnedAt` DATETIME(3) NULL;

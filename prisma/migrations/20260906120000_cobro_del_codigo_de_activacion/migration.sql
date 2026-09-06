-- El cobro que hay detrás de un código de activación.
--
-- Un código se reparte por dos motivos distintos —una venta cobrada fuera de la
-- web o una cortesía— y hasta ahora las dos entregaban lo mismo sin dejar rastro
-- del dinero. Con estas tres columnas la venta se puede apuntar al generar el
-- código, y al canjearlo se crea el pago que la hace aparecer en las cifras.
--
-- Se escribe a mano, como la de `pago_manual_yape`, porque `migrate dev` no
-- puede reproducir el historial en la base de sombra.

ALTER TABLE `activation_codes`
  ADD COLUMN `paymentMethod` VARCHAR(30) NULL,
  ADD COLUMN `paymentRef` VARCHAR(80) NULL,
  ADD COLUMN `amountCents` INT NULL;

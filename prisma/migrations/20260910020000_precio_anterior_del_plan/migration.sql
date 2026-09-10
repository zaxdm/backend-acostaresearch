-- El precio anterior de un plan, para poder tacharlo.
--
-- Una oferta necesita dos cifras: la que se cobra y la que se cobraba. Hasta
-- ahora solo había una, así que anunciar un descuento obligaba a escribir el
-- precio viejo en la plantilla —y un número escrito a mano en el HTML deja de
-- ser verdad en cuanto alguien toca el precio real desde el panel—.
--
-- Aquí solo vive el rótulo. El cobro sigue saliendo de `priceCents`, tanto en
-- PayPal como en el comprobante de Yape: rebajar es bajar `priceCents` y dejar
-- el importe anterior en esta columna, nunca al revés.

ALTER TABLE `plans`
  ADD COLUMN `listPriceCents` INT NULL;

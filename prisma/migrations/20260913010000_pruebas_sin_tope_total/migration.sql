-- Los enlaces de prueba dejan de tener tope total: solo tope por día.
--
-- Se ponen a cero los enlaces que ya existen para que los conectores que se
-- entreguen a partir de ahora salgan sin tope total.
--
-- Lo que NO toca, a propósito: las licencias de los invitados que ya recogieron
-- su conector. El tope se copió a su licencia al recogerlo, y es esa licencia la
-- que se comprueba en cada llamada, así que quien ya está probando sigue
-- exactamente con lo que tenía. Cambiárselo a mitad de su prueba no se ha
-- pedido.
--
-- La columna se queda: sin tope total es 0, que es lo que ya significa «sin tope»
-- en todo el sistema, y borrarla obligaría a tocar el código de las licencias.

UPDATE `trial_links` SET `callsLimitTotal` = 0;

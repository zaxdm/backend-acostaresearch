'use strict';

/**
 * Planes «en prueba»: activos, pero solo para unos correos.
 *
 * POR QUÉ EXISTE
 * --------------
 * Un plan activo sale en la página de precios, en lo que cuenta el asistente,
 * se puede comprar escribiendo su código y se le emite a todos los
 * administradores. Uno inactivo no sirve para probar: el propio administrador
 * pierde su licencia en cuanto abre el panel. Para probar un producto nuevo con
 * una sola persona, sin que lo vea nadie más, hacía falta un tercer estado.
 *
 * `soloPara` nulo es el plan de siempre, y todo el código que no sabe nada de
 * esto se comporta como antes. Con correos, el plan sigue activo para quien
 * está en la lista y no existe para los demás.
 */

/** Los correos de `soloPara`, en minúsculas. Admite coma, punto y coma o saltos. */
function correosDe(soloPara) {
  if (!soloPara) return [];
  return String(soloPara)
    .split(/[\s,;]+/)
    .map((correo) => correo.trim().toLowerCase())
    .filter(Boolean);
}

/** ¿Está en prueba? Un `soloPara` vacío cuenta como plan normal. */
function enPrueba(plan) {
  return correosDe(plan?.soloPara).length > 0;
}

/** ¿Lo puede ver este correo? Un plan normal lo ve cualquiera. */
function visiblePara(plan, email) {
  if (!enPrueba(plan)) return true;
  if (!email) return false;
  return correosDe(plan.soloPara).includes(String(email).trim().toLowerCase());
}

/**
 * Lo que se guarda: los correos sin repetir, separados por coma, o null.
 *
 * Nulo y no cadena vacía: la lista pública filtra por `soloPara: null`, y una
 * cadena vacía dejaría fuera de la venta un plan que nadie quiso esconder.
 */
function normalizar(texto) {
  const correos = [...new Set(correosDe(texto))];
  return correos.length > 0 ? correos.join(', ') : null;
}

module.exports = { correosDe, enPrueba, visiblePara, normalizar };

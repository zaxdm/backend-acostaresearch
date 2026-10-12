'use strict';

const { NotFoundError } = require('../shared/errors/AppError');
const { ROLES } = require('../config/constants');

/**
 * Lo que puede tocar un administrador de país (rol ADMIN_PAIS).
 *
 * Está al revés de lo habitual a propósito: no se le quita lo que no debe ver,
 * se le abre lo que sí. Una ruta del panel que no esté en esta lista le responde
 * 403, así que una sección nueva nace cerrada para él y hay que venir aquí a
 * abrirla. Y abrirla obliga a lo segundo: que su controlador filtre por
 * `req.alcance` (ver `dondePais` y `exigirPais`).
 *
 * `:id` solo casa con un identificador de verdad. Si casara con cualquier cosa,
 * «GET /licenses/:id» abriría de rebote «GET /licenses/review».
 */
const ABIERTAS = [
  // Accesos: los códigos que emite y los que emitió.
  'GET /licenses/codes',
  'POST /licenses/codes',
  'POST /licenses/codes/check-emails',
  'POST /licenses/codes/:id/proof',
  'GET /licenses/codes/:id/proof',
  'DELETE /licenses/codes/:id',
  // Licencias y alertas de sus clientes.
  'GET /licenses',
  'GET /licenses/alerts',
  'GET /licenses/:id',
  'POST /licenses/:id/revoke',
  'POST /licenses/:id/reactivate',
  // Cobros de sus clientes: solo mirar. Aprobar un pago sigue siendo de la casa.
  'GET /payments/recent',
  'GET /payments/manual/pending',
  'GET /payments/manual/history',
  'GET /payments/manual/:id/proof',
  // Sus descuentos y sus enlaces de prueba.
  'GET /billing/discounts',
  'POST /billing/discounts',
  'PATCH /billing/discounts/:id',
  'DELETE /billing/discounts/:id',
  'GET /pruebas',
  'POST /pruebas',
  'PATCH /pruebas/:id',
  'DELETE /pruebas/:id',
  'GET /pruebas/:id/invitados',
  // El avance, las reseñas y los reclamos de sus clientes: solo mirar.
  'GET /embudo',
  'GET /resenas/panel',
  'GET /reclamos',
  // Todas las cuentas, solo mirar.
  'GET /users',
  // El catálogo, los videos y las guías: solo mirar.
  'GET /billing/products',
  'GET /skills',
  'GET /tutoriales/todos',
  'GET /guias/todas',
];

const ID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

const PATRONES = ABIERTAS.map((entrada) => {
  const [metodo, ruta] = entrada.split(' ');
  return { metodo, patron: new RegExp(`^${ruta.replace(/:id/g, ID)}/?$`) };
});

/**
 * ¿Esta ruta del panel está abierta al administrador de país?
 *
 * `ruta` llega ya sin el prefijo de la API: «/licenses/codes».
 */
function abiertaAlPais(metodo, ruta) {
  return PATRONES.some((abierta) => abierta.metodo === metodo && abierta.patron.test(ruta));
}

/** Un país es su código ISO de dos letras, en mayúsculas. Lo demás es nulo. */
function normalizarPais(valor) {
  if (typeof valor !== 'string') return null;
  const pais = valor.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(pais) ? pais : null;
}

/** Lo que manda el dueño en `?pais=` para ver solo lo que no tiene etiqueta. */
const SIN_ETIQUETA = 'ninguno';

/**
 * El alcance de quien pregunta.
 *
 *  - `dePais`: es un administrador de país. Solo ve y solo toca lo de `pais`.
 *  - `filtro`: lo que hay que aplicar a las listas. `undefined` = todo;
 *    un código = ese país; `null` = solo lo que no tiene etiqueta.
 *
 * El `?pais=` solo lo obedece el dueño: a un administrador de país se le aplica
 * siempre el suyo, mande lo que mande.
 */
function alcanceDe(usuario, consulta = {}) {
  if (usuario.role === ROLES.ADMIN_PAIS) {
    return { dePais: true, pais: usuario.pais, filtro: usuario.pais };
  }

  if (consulta?.pais === SIN_ETIQUETA) return { dePais: false, pais: null, filtro: null };
  return { dePais: false, pais: null, filtro: normalizarPais(consulta?.pais) ?? undefined };
}

/** El trozo de `where` de Prisma para una tabla que tiene su propia columna `pais`. */
function dondePais(alcance) {
  if (!alcance || alcance.filtro === undefined) return {};
  return { pais: alcance.filtro };
}

/**
 * Corta el paso a un registro que no es del país de quien pregunta.
 *
 * Responde «no existe» y no «no puedes»: al administrador de un país no se le
 * confirma ni que el registro de otro existe.
 */
function exigirPais(alcance, paisDelRegistro, mensaje = 'No encontramos ese registro.') {
  if (alcance?.dePais && paisDelRegistro !== alcance.pais) throw new NotFoundError(mensaje);
}

module.exports = {
  ABIERTAS,
  SIN_ETIQUETA,
  abiertaAlPais,
  normalizarPais,
  alcanceDe,
  dondePais,
  exigirPais,
};

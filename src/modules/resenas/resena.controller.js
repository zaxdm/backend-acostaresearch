'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created } = require('../../shared/http/apiResponse');
const resenaService = require('./resena.service');

const resenaController = {
  /** Público: las aprobadas, con la media. `?destacadas=1` para la portada. */
  publicas: asyncHandler(async (req, res) => {
    return ok(res, await resenaService.publicas({ soloDestacadas: req.query.destacadas }));
  }),

  /** La suya, con su estado. Null si todavía no ha escrito ninguna. */
  mia: asyncHandler(async (req, res) => {
    return ok(res, { resena: await resenaService.mia(req.user.id) });
  }),

  /**
   * Deja la suya, o reescribe la que ya tenía.
   *
   * 201 la primera vez y 200 al cambiarla: es lo que separa «se creó algo» de
   * «se cambió lo que había», y la web lo usa para decir una cosa u otra.
   */
  guardar: asyncHandler(async (req, res) => {
    const tenia = await resenaService.mia(req.user.id);
    const resena = await resenaService.guardar(req.user.id, req.body);

    const message = tenia
      ? 'Guardamos los cambios. Vuelve a pasar por revisión antes de publicarse.'
      : '¡Gracias! La leeremos antes de publicarla.';

    return tenia ? ok(res, { resena }, { message }) : created(res, { resena }, message);
  }),

  /** Panel: todas, o las de un estado. */
  listar: asyncHandler(async (req, res) => {
    const [resenas, pendientes] = await Promise.all([
      resenaService.listar(req.query.estado),
      resenaService.pendientes(),
    ]);
    return ok(res, { resenas, pendientes });
  }),

  /** Panel: aprobar, rechazar o destacar. */
  revisar: asyncHandler(async (req, res) => {
    const resena = await resenaService.revisar(req.params.id, req.body, req.user.id);
    return ok(res, { resena });
  }),
};

module.exports = resenaController;

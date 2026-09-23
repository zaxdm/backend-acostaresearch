'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created } = require('../../shared/http/apiResponse');
const { NotFoundError } = require('../../shared/errors/AppError');
const resenaService = require('./resena.service');

/**
 * Manda el archivo tal cual, con su tipo.
 *
 * `sendFile` ya responde a los saltos del reproductor (las peticiones por
 * rango), que es lo que permite adelantar un video sin descargarlo entero.
 */
function enviarVideo(res, next, ruta, tipo) {
  res.type(tipo);
  // Se puede cachear: el archivo de una reseña no cambia sin cambiar de id.
  res.set('Cache-Control', 'public, max-age=3600');
  return res.sendFile(ruta, (error) => {
    // Fila con video y sin archivo en disco: que caiga en el 404 de siempre.
    if (error) next(error.status === 404 ? undefined : error);
  });
}

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

  // ── El video del testimonio ─────────────────────────────────────────────

  /** El suyo: sube el video de su reseña, o cambia el que tenía. */
  subirMiVideo: asyncHandler(async (req, res) => {
    const suya = await resenaService.mia(req.user.id);
    if (!suya) {
      throw new NotFoundError('Escribe tu reseña antes de subirle el video.');
    }

    const resena = await resenaService.guardarVideo(suya.id, req.body);
    return ok(res, { resena }, { message: 'Video subido. Lo vemos antes de publicarlo.' });
  }),

  /** El suyo: lo quita y deja el texto. */
  quitarMiVideo: asyncHandler(async (req, res) => {
    const suya = await resenaService.mia(req.user.id);
    if (!suya) throw new NotFoundError('Todavía no has escrito ninguna reseña.');

    const resena = await resenaService.quitarVideo(suya.id);
    return ok(res, { resena }, { message: 'Video quitado.' });
  }),

  /**
   * El video de una reseña APROBADA. Público y sin sesión: lo pide la etiqueta
   * `<video>` de la portada, que no puede mandar la cabecera de nadie.
   */
  verVideo: asyncHandler(async (req, res, next) => {
    const { ruta, tipo } = await resenaService.paraVer(req.params.id);
    return enviarVideo(res, next, ruta, tipo);
  }),

  /** El suyo, en cualquier estado: para verlo antes de que lo aprobemos. */
  verMiVideo: asyncHandler(async (req, res, next) => {
    const suya = await resenaService.mia(req.user.id);
    if (!suya) throw new NotFoundError('Todavía no has escrito ninguna reseña.');

    const { ruta, tipo } = await resenaService.paraVer(suya.id, { soloAprobadas: false });
    return enviarVideo(res, next, ruta, tipo);
  }),

  /** El de cualquiera, para el panel: hay que verlo antes de aprobarlo. */
  verVideoDelPanel: asyncHandler(async (req, res, next) => {
    const { ruta, tipo } = await resenaService.paraVer(req.params.id, { soloAprobadas: false });
    return enviarVideo(res, next, ruta, tipo);
  }),

  /** Panel: da de alta la reseña de un cliente, con su correo. */
  crear: asyncHandler(async (req, res) => {
    const resena = await resenaService.crearDesdeElPanel(req.body, req.user.id);
    return created(res, { resena }, 'Reseña guardada y publicada.');
  }),

  /** Panel: sube el video de una reseña sin devolverla a pendiente. */
  subirVideo: asyncHandler(async (req, res) => {
    const resena = await resenaService.guardarVideo(req.params.id, req.body, { aRevisar: false });
    return ok(res, { resena }, { message: 'Video subido.' });
  }),

  /** Panel: aprobar, rechazar o destacar. */
  revisar: asyncHandler(async (req, res) => {
    const resena = await resenaService.revisar(req.params.id, req.body, req.user.id);
    return ok(res, { resena });
  }),
};

module.exports = resenaController;

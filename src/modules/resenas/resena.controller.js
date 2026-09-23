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

  /** Las suyas, con su estado. Vacío si todavía no ha escrito ninguna. */
  mias: asyncHandler(async (req, res) => {
    return ok(res, { resenas: await resenaService.mias(req.user.id) });
  }),

  /**
   * Deja la suya, o reescribe la que ya tenía.
   *
   * 201 la primera vez y 200 al cambiarla: es lo que separa «se creó algo» de
   * «se cambió lo que había», y la web lo usa para decir una cosa u otra.
   */
  guardar: asyncHandler(async (req, res) => {
    const resena = await resenaService.guardar(req.user.id, req.body);
    return created(res, { resena }, '¡Gracias! La leeremos antes de publicarla.');
  }),

  /** Cambia una de las suyas. Vuelve a quedar pendiente. */
  cambiar: asyncHandler(async (req, res) => {
    const resena = await resenaService.guardar(req.user.id, req.body, req.params.id);
    return ok(res, { resena }, {
      message: 'Guardamos los cambios. Vuelve a pasar por revisión antes de publicarse.',
    });
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

  /**
   * El suyo: sube el video de una reseña suya, o cambia el que tenía.
   *
   * `suya` comprueba las dos cosas que importan: que sea de quien lo pide y que
   * no sea una de las que publicamos nosotros a su nombre.
   */
  subirMiVideo: asyncHandler(async (req, res) => {
    await resenaService.suya(req.params.id, req.user.id);
    const resena = await resenaService.guardarVideo(req.params.id, req.body);
    return ok(res, { resena }, { message: 'Video subido. Lo vemos antes de publicarlo.' });
  }),

  /** El suyo: lo quita y deja el texto. */
  quitarMiVideo: asyncHandler(async (req, res) => {
    await resenaService.suya(req.params.id, req.user.id);
    const resena = await resenaService.quitarVideo(req.params.id);
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

  /**
   * El suyo, en cualquier estado: para verlo antes de que lo aprobemos.
   *
   * Aquí sí valen las del panel: verlas no es tocarlas, y quien tiene una
   * publicada a su nombre tiene derecho a mirar qué se publicó.
   */
  verMiVideo: asyncHandler(async (req, res, next) => {
    const suyas = await resenaService.mias(req.user.id);
    if (!suyas.some((r) => r.id === req.params.id)) {
      throw new NotFoundError('Esa reseña no existe.');
    }

    const { ruta, tipo } = await resenaService.paraVer(req.params.id, { soloAprobadas: false });
    return enviarVideo(res, next, ruta, tipo);
  }),

  /** El de cualquiera, para el panel: hay que verlo antes de aprobarlo. */
  verVideoDelPanel: asyncHandler(async (req, res, next) => {
    const { ruta, tipo } = await resenaService.paraVer(req.params.id, { soloAprobadas: false });
    return enviarVideo(res, next, ruta, tipo);
  }),

  /**
   * Panel: da de alta la reseña de un cliente, con su correo.
   *
   * Si ese correo no tiene cuenta se guarda igual y se dice en el mismo aviso:
   * el testimonio puede ser real —hay quien compró por otra vía—, pero una
   * firma sin cuenta detrás no se puede comprobar y quien la publica tiene que
   * saberlo ahora, no descubrirlo después.
   */
  crear: asyncHandler(async (req, res) => {
    const resena = await resenaService.crearDesdeElPanel(req.body, req.user.id);

    const message = resena.sinCuenta
      ? `Guardada y publicada, pero OJO: no hay ninguna cuenta con ${resena.correo}. Se firma igual con ese correo, aunque nadie ha comprado con él.`
      : 'Reseña guardada y publicada.';

    return created(res, { resena }, message);
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

  /**
   * Panel: la borra del todo, con su video. No se puede deshacer.
   *
   * Es otra cosa que rechazarla: rechazar deja la fila y su motivo para quien
   * la escribió, y esto es para lo que nunca fue una reseña —las de prueba, las
   * del correo equivocado—, donde no hay a quién responder.
   */
  borrar: asyncHandler(async (req, res) => {
    const { id } = await resenaService.borrar(req.params.id, req.user.id);
    return ok(res, { id }, { message: 'Reseña borrada.' });
  }),
};

module.exports = resenaController;

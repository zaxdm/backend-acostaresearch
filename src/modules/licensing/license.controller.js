'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created, noContent } = require('../../shared/http/apiResponse');
const { addDays } = require('../../shared/utils/tokens');
const licenseService = require('./license.service');
const { ValidationError } = require('../../shared/errors/AppError');
const { ROLES } = require('../../config/constants');

const licenseController = {
  /** Solo ADMIN. Los códigos en claro se devuelven aquí y nunca más. */
  generate: asyncHandler(async (req, res) => {
    const { expiraEnDias, importe, ...resto } = req.body;

    const resultado = await licenseService.generateCodes({
      ...resto,
      createdById: req.user.id,
      expiresAt: expiraEnDias ? addDays(new Date(), expiraEnDias) : undefined,
      // El panel pide soles porque es lo que el administrador tiene delante; la
      // base de datos guarda céntimos, como todo el resto del dinero.
      amountCents: importe === undefined ? undefined : Math.round(importe * 100),
    });

    return created(
      res,
      resultado,
      'Códigos generados. Cópialos ahora: no se pueden volver a consultar.',
    );
  }),

  subirComprobante: asyncHandler(async (req, res) => {
    // `express.raw` deja un Buffer vacío cuando el tipo no encaja; se comprueba
    // aquí para responder «falta la imagen» en vez de fallar más adentro.
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new ValidationError(
        [{ field: 'imagen', message: 'Adjunta una imagen PNG, JPG o WEBP.' }],
        'No llegó ninguna imagen.',
      );
    }

    const guardado = await licenseService.adjuntarComprobante(req.params.id, req.body);
    return ok(res, { proof: guardado }, { message: 'Comprobante guardado.' });
  }),

  /**
   * Devuelve la imagen tal cual, no un JSON con la imagen dentro.
   *
   * Se sirve por la API y no como archivo estático porque hay que comprobar la
   * sesión: un comprobante lleva el nombre y el importe de una venta.
   */
  verComprobante: asyncHandler(async (req, res) => {
    const { buffer, mime } = await licenseService.comprobanteDe(req.params.id);

    res.set('Content-Type', mime ?? 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=300');
    return res.send(buffer);
  }),

  codes: asyncHandler(async (req, res) => {
    const codes = await licenseService.listCodes(req.query);
    return ok(res, { codes });
  }),

  voidCode: asyncHandler(async (req, res) => {
    await licenseService.voidCode(req.params.id);
    return noContent(res);
  }),

  /** Borrar de verdad. Anular es lo otro, y sigue estando. */
  deleteCode: asyncHandler(async (req, res) => {
    await licenseService.deleteCode(req.params.id);
    return noContent(res);
  }),

  /** El comprador canjea su código estando dentro de su cuenta. */
  redeem: asyncHandler(async (req, res) => {
    const resultado = await licenseService.redeemCode({
      userId: req.user.id,
      code: req.body.code,
    });
    return created(res, resultado, 'Licencia activada. Pega la URL en Claude para empezar.');
  }),

  /** Vuelve a generar la URL del conector. La anterior deja de servir. */
  rotate: asyncHandler(async (req, res) => {
    const resultado = await licenseService.rotate({
      licenseId: req.params.id,
      userId: req.user.id,
    });
    return ok(res, resultado, {
      message: 'URL nueva generada. La anterior ya no funciona: actualízala en Claude.',
    });
  }),

  mine: asyncHandler(async (req, res) => {
    // El administrador no compra su propio producto: se le emite aquí, la
    // primera vez que abre el panel, gratis y sin caducidad. Va en esta lectura
    // y no en un botón porque así también lo alcanza el día que se añada una
    // ruta nueva al catálogo, sin que él tenga que acordarse de nada.
    if (req.user.role === ROLES.ADMIN) {
      await licenseService.ensureForAdmin(req.user.id);
    }

    // El progreso viaja con las licencias y no en su propia ruta: el panel las
    // pide juntas y siempre a la vez, así que partirlo en dos serían dos viajes
    // para pintar una sola pantalla.
    const [licenses, progreso] = await Promise.all([
      licenseService.listForUser(req.user.id),
      licenseService.progresoDeArranque(req.user.id),
    ]);

    return ok(res, { licenses, progreso });
  }),

  list: asyncHandler(async (req, res) => {
    const licenses = await licenseService.listAll(req.query);
    return ok(res, { licenses });
  }),

  inspect: asyncHandler(async (req, res) => {
    const ficha = await licenseService.inspect(req.params.id);
    return ok(res, ficha);
  }),

  /** Alertas abiertas de todas las licencias: la bandeja del administrador. */
  alerts: asyncHandler(async (_req, res) => {
    const alerts = await licenseService.openAlerts();
    return ok(res, { alerts });
  }),

  /** Repaso de todas las licencias activas en busca de patrones raros. */
  review: asyncHandler(async (_req, res) => {
    const hallazgos = await licenseService.review();
    return ok(res, { hallazgos });
  }),

  revoke: asyncHandler(async (req, res) => {
    const license = await licenseService.revoke(req.params.id, req.body.reason);
    return ok(res, { license }, { message: 'Licencia revocada.' });
  }),

  reactivate: asyncHandler(async (req, res) => {
    const license = await licenseService.reactivate(req.params.id);
    return ok(res, { license }, { message: 'Licencia reactivada.' });
  }),

  /**
   * Mueve la licencia a otro producto y avisa al comprador por correo.
   *
   * El mensaje nombra los dos productos porque quien lo hace suele estar
   * moviendo varias licencias seguidas, y «Licencia actualizada» a secas no
   * deja ver si se equivocó de fila.
   */
  changeProduct: asyncHandler(async (req, res) => {
    const { license, anterior } = await licenseService.changeProduct({
      id: req.params.id,
      productCode: req.body.productCode,
      byId: req.user.id,
    });

    return ok(
      res,
      { license },
      { message: `Licencia movida de ${anterior} a ${license.productCode}. Le avisamos por correo.` },
    );
  }),

  /** Borrado de verdad. Para limpiar pruebas; a un cliente se le revoca. */
  eliminar: asyncHandler(async (req, res) => {
    await licenseService.eliminar({ id: req.params.id, adminId: req.user.id });
    return noContent(res);
  }),
};

module.exports = licenseController;

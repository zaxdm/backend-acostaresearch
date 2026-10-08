'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created } = require('../../shared/http/apiResponse');
const manualService = require('./manual.service');

const manualController = {
  /**
   * Datos del cobro por Yape y por Western Union. Público: la web los enseña
   * antes de que nadie inicie sesión. `westernUnion` es null si no se ofrece.
   */
  datosDePago: asyncHandler(async (_req, res) => {
    return ok(res, {
      yape: manualService.datosDePago(),
      westernUnion: manualService.datosWesternUnion(),
    });
  }),

  /**
   * El comprador manda su captura.
   *
   * La imagen viaja como cuerpo crudo y el resto de datos en la query. Es
   * deliberado: evita meter una librería de multipart solo para esto, y así el
   * cuerpo de la petición es exactamente el archivo, sin nada que desenredar.
   */
  registrar: asyncHandler(async (req, res) => {
    const { items } = req.query;

    // Un carrito de un solo producto es un Yape de los de siempre.
    const resultado =
      items && items.length > 1
        ? await manualService.registrarCarrito({
            userId: req.user.id,
            items,
            // El código del carrito rebaja el total, una sola vez.
            discountCode: req.query.discountCode,
            operationCode: req.query.operationCode,
            buffer: req.body,
            metodo: req.query.metodo,
          })
        : await manualService.registrar({
            userId: req.user.id,
            planCode: items ? items[0].planCode : req.query.planCode,
            discountCode: (items && items[0].discountCode) || req.query.discountCode,
            operationCode: req.query.operationCode,
            buffer: req.body,
            metodo: req.query.metodo,
          });

    return created(
      res,
      resultado,
      'Recibimos tu comprobante. Lo revisamos y te avisamos por correo en cuanto quede activo.',
    );
  }),

  /**
   * Revisión previa de la captura, antes de enviarla: si parece un
   * comprobante y qué número de operación se lee. No guarda nada.
   */
  revisarCaptura: asyncHandler(async (req, res) => {
    const revision = await manualService.revisarAntesDeEnviar({
      buffer: req.body,
      metodo: req.query.metodo,
      monto: req.query.monto,
    });
    return ok(res, revision);
  }),

  pendientes: asyncHandler(async (_req, res) => {
    const payments = await manualService.pendientes();
    return ok(res, { payments });
  }),

  historial: asyncHandler(async (_req, res) => {
    const payments = await manualService.historial();
    return ok(res, { payments });
  }),

  /** La imagen, tal cual. No se cachea: es un documento de un cobro. */
  comprobante: asyncHandler(async (req, res) => {
    const { buffer, mime } = await manualService.comprobante(req.params.id);

    res.setHeader('Content-Type', mime || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buffer);
  }),

  aprobar: asyncHandler(async (req, res) => {
    const resultado = await manualService.aprobar({
      paymentId: req.params.id,
      adminId: req.user.id,
    });

    return ok(res, resultado, {
      message: resultado.alreadyProcessed
        ? 'Este pago ya estaba aprobado.'
        : 'Pago aprobado. El comprador ya tiene su acceso y le hemos avisado.',
    });
  }),

  rechazar: asyncHandler(async (req, res) => {
    const resultado = await manualService.rechazar({
      paymentId: req.params.id,
      adminId: req.user.id,
      motivo: req.body.motivo,
    });

    return ok(res, resultado, { message: 'Comprobante rechazado. Se lo hemos comunicado.' });
  }),
};

module.exports = manualController;

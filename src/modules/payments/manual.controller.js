'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created } = require('../../shared/http/apiResponse');
const manualService = require('./manual.service');
const billeteraService = require('./billetera.service');
const medioService = require('./medio.service');

const manualController = {
  /**
   * Datos del cobro por Yape y por Western Union. Público: la web los enseña
   * antes de que nadie inicie sesión. `westernUnion` es null si no se ofrece.
   */
  datosDePago: asyncHandler(async (_req, res) => {
    // Lo del `.env`, con lo que el dueño haya cambiado o apagado en el panel.
    const { yape, westernUnion } = await medioService.paraElCheckout({
      yape: manualService.datosDePago(),
      westernUnion: manualService.datosWesternUnion(),
    });
    return ok(res, {
      yape,
      westernUnion,
      // Las billeteras de país activas: Deuna en Ecuador, Nequi en Colombia…
      billeteras: await billeteraService.publicas(),
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
            billeteraId: req.query.billetera,
          })
        : await manualService.registrar({
            userId: req.user.id,
            planCode: items ? items[0].planCode : req.query.planCode,
            discountCode: (items && items[0].discountCode) || req.query.discountCode,
            operationCode: req.query.operationCode,
            buffer: req.body,
            metodo: req.query.metodo,
            billeteraId: req.query.billetera,
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

  pendientes: asyncHandler(async (req, res) => {
    const payments = await manualService.pendientes({ pais: req.alcance.filtro });
    return ok(res, { payments });
  }),

  historial: asyncHandler(async (req, res) => {
    const payments = await manualService.historial({ pais: req.alcance.filtro });
    return ok(res, { payments });
  }),

  /** La imagen, tal cual. No se cachea: es un documento de un cobro. */
  comprobante: asyncHandler(async (req, res) => {
    await manualService.exigirAlcance(req.params.id, req.alcance);
    const { buffer, mime } = await manualService.comprobante(req.params.id);

    res.setHeader('Content-Type', mime || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buffer);
  }),

  aprobar: asyncHandler(async (req, res) => {
    await manualService.exigirAlcance(req.params.id, req.alcance);
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
    await manualService.exigirAlcance(req.params.id, req.alcance);
    const resultado = await manualService.rechazar({
      paymentId: req.params.id,
      adminId: req.user.id,
      motivo: req.body.motivo,
    });

    return ok(res, resultado, { message: 'Comprobante rechazado. Se lo hemos comunicado.' });
  }),
};

/**
 * El catálogo de billeteras de país, en el panel del dueño. Solo él: ninguna
 * de estas rutas está en la lista de `panelDePais`.
 */
const billeteraController = {
  listar: asyncHandler(async (_req, res) => {
    return ok(res, { billeteras: await billeteraService.listar() });
  }),

  crear: asyncHandler(async (req, res) => {
    const billetera = await billeteraService.crear({ ...req.body, createdById: req.user.id });
    return created(res, { billetera }, `Billetera «${billetera.nombre}» creada.`);
  }),

  cambiar: asyncHandler(async (req, res) => {
    const billetera = await billeteraService.cambiar(req.params.id, req.body, req.user.id);
    return ok(res, { billetera }, { message: `«${billetera.nombre}» actualizada.` });
  }),

  /** La imagen llega como cuerpo crudo, igual que la captura de un pago. */
  subirQr: asyncHandler(async (req, res) => {
    const billetera = await billeteraService.guardarQr(req.params.id, req.body, req.user.id);
    return ok(res, { billetera }, { message: `QR de «${billetera.nombre}» guardado.` });
  }),

  /** Público: lo pide la etiqueta de imagen del checkout, sin sesión. */
  verQr: asyncHandler(async (req, res) => {
    const { buffer, mime } = await billeteraService.qr(req.params.id);
    res.setHeader('Content-Type', mime || 'application/octet-stream');
    // La dirección lleva la versión del QR: si se sube otro, cambia.
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(buffer);
  }),
};

/** Los medios de pago de la casa, desde el panel del dueño. Ver `medio.service`. */
const medioController = {
  listar: asyncHandler(async (_req, res) => {
    return ok(res, { medios: await medioService.listar() });
  }),

  cambiar: asyncHandler(async (req, res) => {
    const medio = await medioService.cambiar(req.params.codigo, req.body, req.user.id);
    return ok(res, { medio }, { message: `«${medio.nombre}» actualizado.` });
  }),

  subirQr: asyncHandler(async (req, res) => {
    const medio = await medioService.guardarQr(req.params.codigo, req.body, req.user.id);
    return ok(res, { medio }, { message: `QR de «${medio.nombre}» guardado.` });
  }),

  /** Público: lo pide la etiqueta de imagen del checkout, sin sesión. */
  verQr: asyncHandler(async (req, res) => {
    const { buffer, mime } = await medioService.qr(req.params.codigo);
    res.setHeader('Content-Type', mime || 'application/octet-stream');
    // La dirección lleva la versión del QR: si se sube otro, cambia.
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(buffer);
  }),
};

module.exports = manualController;
module.exports.billeteraController = billeteraController;
module.exports.medioController = medioController;

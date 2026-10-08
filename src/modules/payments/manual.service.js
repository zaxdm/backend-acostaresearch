'use strict';

const crypto = require('node:crypto');
const prisma = require('../../lib/prisma');
const env = require('../../config/env');
const logger = require('../../config/logger');
const { ERROR_CODES } = require('../../config/constants');
const { sendMail } = require('../../lib/mailer');
const plantillas = require('../../lib/emailTemplates');
const { avisarAlAdmin } = require('../../lib/notify');
const billingRepository = require('../billing/billing.repository');
const { enPrueba } = require('../billing/plan.visibilidad');
const discountService = require('../billing/discount.service');
const paymentRepository = require('./payment.repository');
const proofStorage = require('./proof.storage');
const { revisarCaptura } = require('./proof.revision');
const { entregarPago } = require('./payment.delivery');
const carrito = require('./payment.carrito');
const { AppError, NotFoundError } = require('../../shared/errors/AppError');

/**
 * Pago manual por Yape o por Western Union.
 *
 * El comprador paga con el QR (o envía el giro), sube la captura y espera; un administrador la
 * mira y aprueba o rechaza. Solo al aprobar se crea la licencia, y con ella la
 * URL del conector.
 *
 * POR QUÉ HAY UNA PERSONA EN MEDIO
 * ---------------------------------
 * Una captura de pantalla no prueba nada: se falsifica en dos minutos y no hay
 * ninguna API de Yape con la que comprobarla. La revisión a mano no es una
 * carencia del sistema, es el único control que existe. Por eso el aviso al
 * administrador lleva el número de operación: lo que se coteja es el extracto
 * real, no la imagen.
 *
 * LA URL SÍ VIAJA POR CORREO, PERO NO SALE DE AQUÍ
 * -------------------------------------------------
 * Al aprobar se crea la licencia y su URL se le manda al comprador por correo.
 * Antes no: se le mandaba al panel a generarla él. Se cambió porque quien paga
 * por Yape no está mirando la pantalla cuando aprobamos —han pasado horas—, y
 * el correo es la única superficie que le alcanza en ese momento.
 *
 * El envío NO se hace en este archivo, sino en `payment.delivery`, que es el
 * mismo punto por el que pasa un cobro de pasarela: lo que recibe el comprador
 * no puede depender de por dónde pagó.
 *
 * Al administrador se le sigue sin enseñar esa URL: quien mira esta pantalla no
 * es el dueño de la licencia.
 */

/**
 * Los dos cobros manuales. Se revisan igual —captura, persona, entrega—; lo que
 * cambia es la moneda y, con ella, el precio.
 *
 * Yape cobra en soles, que es la moneda en la que se anuncian los precios.
 * Western Union lo usa quien paga desde fuera del Perú, y a ese comprador se le
 * cobra el precio en dólares de PayPal: dos precios distintos en dólares por la
 * misma compra no tendrían explicación.
 */
const MEDIOS = Object.freeze({
  YAPE: {
    proveedor: 'YAPE',
    nombre: 'Yape',
    moneda: 'PEN',
    prefijo: 'YP',
    precio: (plan) => plan.priceCents,
    rebaja: (descuento) => descuento.amountCents,
  },
  WESTERN_UNION: {
    proveedor: 'WESTERN_UNION',
    nombre: 'Western Union',
    moneda: 'USD',
    prefijo: 'WU',
    precio: (plan) => plan.priceUsdCents,
    rebaja: (descuento) => descuento.discountUsdCents,
  },
});

const PROVEEDORES = Object.values(MEDIOS).map((medio) => medio.proveedor);

/** El medio pedido, o un 409 si no se ofrece (Western Union sin beneficiario). */
function medioDe(metodo = 'YAPE') {
  const medio = MEDIOS[metodo] ?? MEDIOS.YAPE;

  if (medio.proveedor === 'WESTERN_UNION' && !env.westernUnion.activo) {
    throw new AppError('Por ahora no recibimos pagos por Western Union.', {
      statusCode: 409,
      code: ERROR_CODES.PAYMENT_FAILED,
    });
  }
  return medio;
}

/** El medio de un pago ya guardado, para los textos de la revisión. */
function medioDelPago(payment) {
  return MEDIOS[payment.provider] ?? MEDIOS.YAPE;
}

/** Importe para un aviso corto: «S/ 69.00» o «US$ 25.00». */
function importe(cents, moneda) {
  return `${moneda === 'USD' ? 'US$' : 'S/'} ${(cents / 100).toFixed(2)}`;
}

/** Sin O/0 ni I/1: la referencia se dicta por WhatsApp cuando algo se tuerce. */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generarReferencia(prefijo) {
  let cuerpo = '';
  for (let i = 0; i < 8; i += 1) cuerpo += ALFABETO[crypto.randomInt(0, ALFABETO.length)];
  return `${prefijo}-${cuerpo}`;
}

/**
 * Lee la captura ya guardada y apunta el veredicto en sus filas, para que el
 * administrador lo vea en la bandeja. Va después de responder al comprador:
 * el OCR tarda y comparte cola con los reportes de Turnitin. Si falla, la
 * bandeja simplemente no enseña nada.
 */
function revisarEnSegundoPlano(ids, buffer, { amountCents, metodo, operationCode }) {
  revisarCaptura(buffer, { amountCents, metodo, operationCode, esperaMs: 5 * 60_000 })
    .then((revision) => paymentRepository.saveProofCheck(ids, revision))
    .catch((error) => {
      logger.warn({ err: error, ids }, 'No se pudo apuntar la revisión automática de la captura');
    });
}

/** El veredicto guardado, de vuelta a objeto. Null si no hay o no se entiende. */
function leerRevision(texto) {
  if (!texto) return null;
  try {
    return JSON.parse(texto);
  } catch {
    return null;
  }
}

/** El comprador, con lo justo para escribirle y para que el admin lo reconozca. */
const COMPRADOR = { id: true, email: true, firstName: true, lastName: true };

/**
 * Avisa sin bloquear.
 *
 * Un fallo del correo no puede tumbar la operación: el comprobante ya está
 * guardado y el pago ya está aprobado. Se registra y se sigue.
 */
function avisar(destinatario, mensaje, contexto) {
  if (!destinatario) return;

  sendMail({ to: destinatario, ...mensaje }).catch((error) => {
    logger.error({ err: error, ...contexto }, 'No se pudo enviar el aviso del pago manual');
  });
}

/**
 * A quién avisar de que hay un comprobante esperando.
 *
 * Si no está configurado en el .env se busca un administrador activo: es
 * preferible mirar en la base de datos a que el aviso se pierda porque nadie
 * rellenó una variable.
 */
async function correoDelAdministrador() {
  if (env.ADMIN_NOTIFY_EMAIL) return env.ADMIN_NOTIFY_EMAIL;

  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN', status: 'ACTIVE' },
    select: { email: true },
    orderBy: { createdAt: 'asc' },
  });

  if (!admin) {
    logger.warn('No hay ningún administrador al que avisar de los comprobantes de Yape');
    return null;
  }

  return admin.email;
}

/**
 * Qué se entregó, para que el administrador lo vea en el panel.
 *
 * Tres formas porque hay tres productos, y cada uno se comprueba mirando una
 * cosa distinta: la licencia por su producto, la bolsa por sus palabras y la
 * membresía por sus documentos al mes.
 */
function loEntregado(plan, entrega) {
  if (plan.kind === 'LICENSE') {
    return {
      tipo: 'LICENSE',
      licenseId: entrega.license.id,
      productCode: entrega.license.productCode,
    };
  }
  if (plan.kind === 'DOCUMENTO') {
    return {
      tipo: 'DOCUMENTO',
      docPackId: entrega.membresia.id,
      docsPorMes: entrega.membresia.docsPorMes,
      expiresAt: entrega.membresia.expiresAt,
      renovada: Boolean(entrega.renovada),
    };
  }
  return { tipo: 'WORDS', packId: entrega.pack.id, words: entrega.pack.wordsTotal };
}

/** Los datos del cobro manual que quedan en el pago al aprobarlo. */
function capturaManual(payment, adminId) {
  return {
    // El número de operación es lo que permite cuadrarlo con el extracto;
    // si el comprador no lo puso, queda nuestra referencia.
    captureId: payment.operationCode || payment.providerOrderId,
    payerEmail: payment.user.email,
    raw: { metodo: payment.provider, aprobadoPor: adminId, aprobadoEn: new Date().toISOString() },
  };
}

/**
 * Aprueba todas las filas de un carrito, una detrás de otra y por el mismo
 * `entregarPago` que una compra suelta: si trae dos licencias, la segunda ve
 * ya creada la primera. La que otro administrador aprobó un instante antes
 * simplemente no entrega nada.
 */
async function aprobarCarrito({ cartId, adminId }) {
  const filas = (await paymentRepository.findCart(cartId)).filter(
    (fila) => fila.status === 'IN_REVIEW',
  );
  const entregados = [];

  for (const fila of filas) {
    const entrega = await entregarPago({
      payment: fila,
      estadoEsperado: 'IN_REVIEW',
      captura: capturaManual(fila, adminId),
      notaBolsa: `Pago por ${medioDelPago(fila).nombre} confirmado a mano (carrito)`,
    });
    if (!entrega) continue;

    await paymentRepository.markReviewed(fila.id, adminId);
    entregados.push(loEntregado(fila.plan, entrega));
  }

  logger.info(
    { cartId, adminId, productos: entregados.length },
    'Yape de un carrito aprobado y productos entregados',
  );

  return {
    alreadyProcessed: entregados.length === 0,
    payment: { id: filas[0]?.id ?? null, status: 'PAID' },
    entregado: entregados[0] ?? null,
    entregados,
  };
}

const manualService = {
  /** Datos del cobro que la web enseña junto al QR. */
  datosDePago() {
    return { titular: env.yape.titular, numero: env.yape.numero, currency: MEDIOS.YAPE.moneda };
  },

  /** A quién mandar el Western Union. `null` = no se ofrece. */
  datosWesternUnion() {
    const wu = env.westernUnion;
    if (!wu.activo) return null;
    return {
      beneficiario: wu.beneficiario,
      dni: wu.dni,
      ciudad: wu.ciudad,
      currency: MEDIOS.WESTERN_UNION.moneda,
    };
  },

  /**
   * Registra el pago y guarda el comprobante, en una sola operación.
   *
   * Van juntos a propósito: si fueran dos pasos, cada intento fallido de subir
   * la imagen dejaría una fila de pago huérfana que nadie va a mirar nunca.
   *
   * El importe lo calcula el servidor a partir del plan, igual que en PayPal.
   * Lo que diga el comprador que pagó es un dato del comprobante, no el precio.
   */
  async registrar({ userId, planCode, discountCode, operationCode, buffer, metodo }) {
    const medio = medioDe(metodo);
    const plan = await billingRepository.findPlanByCode(planCode);
    // Igual que en la pasarela: uno en prueba no se vende aunque esté activo.
    if (!plan || !plan.active || enPrueba(plan)) {
      throw new NotFoundError(`No existe un plan activo con el código ${planCode}.`);
    }

    const precio = medio.precio(plan);
    if (!precio || precio <= 0) {
      throw new AppError(`El plan ${plan.name} no se vende por ${medio.nombre}.`, {
        statusCode: 409,
        code: ERROR_CODES.PLAN_NOT_PURCHASABLE,
      });
    }

    const descuento = await discountService.resolve({ code: discountCode, plan });
    const rebaja = descuento ? medio.rebaja(descuento) : 0;
    const amountCents = precio - rebaja;

    const payment = await paymentRepository.create({
      userId,
      planId: plan.id,
      provider: medio.proveedor,
      providerOrderId: generarReferencia(medio.prefijo),
      amountCents,
      currency: medio.moneda,
      discountCodeId: descuento ? descuento.id : null,
      discountCents: rebaja,
      operationCode: operationCode || null,
    });

    let comprobante;
    try {
      comprobante = await proofStorage.guardar(buffer, { paymentId: payment.id });
    } catch (error) {
      // Sin captura no hay nada que revisar: la fila se cierra en vez de
      // quedarse pendiente para siempre.
      await paymentRepository.fail(payment.id, { errorCode: 'PROOF_REJECTED' });
      throw error;
    }

    const enganchado = await paymentRepository.attachProof(payment.id, {
      userId,
      proofPath: comprobante.path,
      proofMime: comprobante.mime,
    });

    if (!enganchado) {
      await proofStorage.borrar(comprobante.path);
      throw new AppError('No pudimos registrar tu comprobante. Vuelve a intentarlo.', {
        statusCode: 409,
        code: ERROR_CODES.PAYMENT_FAILED,
      });
    }

    const comprador = await prisma.user.findUnique({ where: { id: userId }, select: COMPRADOR });

    logger.info(
      { userId, paymentId: payment.id, plan: plan.code, amountCents, metodo: medio.proveedor },
      'Comprobante manual recibido, pendiente de revisión',
    );

    avisar(
      await correoDelAdministrador(),
      plantillas.manualPaymentReceived({
        buyer: comprador,
        planName: plan.name,
        amountCents,
        currency: medio.moneda,
        metodo: medio.nombre,
        operationCode: operationCode || null,
        paymentId: payment.id,
      }),
      { paymentId: payment.id },
    );

    // Y un empujón al móvil, porque el correo se lee cuando uno abre el correo
    // y esto espera a que alguien lo mire. Va sin el correo del comprador a
    // propósito: ver quién es y su comprobante exige entrar al panel.
    avisarAlAdmin({
      titulo: `${medio.nombre} por revisar · ${importe(amountCents, medio.moneda)}`,
      mensaje: `${comprador.firstName} ${(comprador.lastName || '').charAt(0)}. · ${plan.name}`,
      etiquetas: ['moneybag'],
      enlace: `${env.APP_URL}/admin?seccion=yape`,
    });

    revisarEnSegundoPlano([payment.id], buffer, {
      amountCents,
      metodo: medio.proveedor,
      operationCode,
    });

    return {
      paymentId: payment.id,
      reference: payment.providerOrderId,
      amountCents,
      currency: medio.moneda,
      status: 'IN_REVIEW',
      plan: { code: plan.code, name: plan.name },
    };
  },

  /**
   * Un Yape por todo el carrito: una captura, un importe y una sola revisión.
   *
   * Cada producto queda en su propia fila con su referencia, y todas apuntan a
   * la misma captura. El administrador ve UN comprobante por la suma, y al
   * aprobarlo se entregan todos.
   */
  async registrarCarrito({ userId, items, discountCode, operationCode, buffer, metodo }) {
    const medio = medioDe(metodo);
    const { lineas, delTotal } = await carrito.resolverLineas(items, {
      precio: medio.precio,
      rebaja: medio.rebaja,
      medio: medio.nombre,
      discountCode,
    });
    const amountCents = lineas.reduce((suma, linea) => suma + linea.amountCents, 0);
    const nombre = carrito.nombreDelCarrito(lineas.map((linea) => linea.plan));
    const cartId = crypto.randomUUID();

    const filas = await paymentRepository.createCart(
      lineas.map((linea) => ({
        userId,
        planId: linea.plan.id,
        provider: medio.proveedor,
        providerOrderId: generarReferencia(medio.prefijo),
        amountCents: linea.amountCents,
        currency: medio.moneda,
        discountCodeId: carrito.codigoDeLaFila(linea, delTotal),
        discountCents: linea.rebaja,
        operationCode: operationCode || null,
        cartId,
      })),
    );
    const lider = filas[0];
    const cerrarTodas = (errorCode) =>
      Promise.all(filas.map((fila) => paymentRepository.fail(fila.id, { errorCode })));

    let comprobante;
    try {
      comprobante = await proofStorage.guardar(buffer, { paymentId: lider.id });
    } catch (error) {
      await cerrarTodas('PROOF_REJECTED');
      throw error;
    }

    const enganchados = await Promise.all(
      filas.map((fila) =>
        paymentRepository.attachProof(fila.id, {
          userId,
          proofPath: comprobante.path,
          proofMime: comprobante.mime,
        }),
      ),
    );

    if (enganchados.some((ok) => !ok)) {
      await cerrarTodas('PROOF_REJECTED');
      await proofStorage.borrar(comprobante.path);
      throw new AppError('No pudimos registrar tu comprobante. Vuelve a intentarlo.', {
        statusCode: 409,
        code: ERROR_CODES.PAYMENT_FAILED,
      });
    }

    const comprador = await prisma.user.findUnique({ where: { id: userId }, select: COMPRADOR });

    logger.info(
      { userId, cartId, productos: filas.length, amountCents, metodo: medio.proveedor },
      'Comprobante manual de un carrito recibido, pendiente de revisión',
    );

    // Un solo aviso por la suma: es un solo comprobante que mirar.
    avisar(
      await correoDelAdministrador(),
      plantillas.manualPaymentReceived({
        buyer: comprador,
        planName: nombre,
        amountCents,
        currency: medio.moneda,
        metodo: medio.nombre,
        operationCode: operationCode || null,
        paymentId: lider.id,
      }),
      { paymentId: lider.id, cartId },
    );
    avisarAlAdmin({
      titulo: `${medio.nombre} por revisar · ${importe(amountCents, medio.moneda)}`,
      mensaje: `${comprador.firstName} ${(comprador.lastName || '').charAt(0)}. · ${nombre}`,
      etiquetas: ['moneybag'],
      enlace: `${env.APP_URL}/admin?seccion=yape`,
    });

    revisarEnSegundoPlano(
      filas.map((fila) => fila.id),
      buffer,
      { amountCents, metodo: medio.proveedor, operationCode },
    );

    return {
      paymentId: lider.id,
      reference: lider.providerOrderId,
      amountCents,
      currency: medio.moneda,
      status: 'IN_REVIEW',
      plan: { code: 'CARRITO', name: nombre },
      discount: carrito.resumenDelTotal(delTotal),
      items: carrito.resumenDeLineas(lineas),
    };
  },

  /**
   * Comprobantes esperando revisión. Es la bandeja del administrador.
   *
   * Un carrito sale UNA vez, con la suma y la lista de lo que lleva: es una
   * sola captura por un solo importe. Enseñarlo como dos filas con la misma
   * imagen y cifras que no cuadran con ella invitaba a aprobar una y olvidar
   * la otra.
   */
  async pendientes() {
    const filas = await paymentRepository.listInReview();
    const porCarrito = new Map();
    const bandeja = [];

    for (const { proofCheck, ...resto } of filas) {
      const fila = { ...resto, revision: leerRevision(proofCheck) };
      if (!fila.cartId) {
        bandeja.push({ ...fila, carrito: null });
        continue;
      }

      const visto = porCarrito.get(fila.cartId);
      if (!visto) {
        const entrada = {
          ...fila,
          carrito: { productos: [fila.plan.name], pagos: [fila.id] },
        };
        porCarrito.set(fila.cartId, entrada);
        bandeja.push(entrada);
        continue;
      }

      visto.amountCents += fila.amountCents;
      visto.discountCents += fila.discountCents;
      visto.carrito.productos.push(fila.plan.name);
      visto.carrito.pagos.push(fila.id);
    }

    return bandeja;
  },

  /**
   * Historial: los comprobantes que ya pasaron por la bandeja.
   *
   * Se devuelve la tanda entera —las últimas doscientas— y el panel busca y
   * filtra dentro. Con este volumen, paginar contra el servidor solo añadiría
   * una espera por cada letra escrita en el buscador.
   *
   * La ruta del comprobante NO sale de aquí: es una ruta de disco y no le sirve
   * de nada a quien mira el panel. Se cambia por un booleano, que es la única
   * pregunta que hace la pantalla: ¿hay imagen que abrir?
   */
  async historial({ limit } = {}) {
    const pagos = await paymentRepository.listReviewed({ provider: PROVEEDORES, limit });

    return pagos.map(({ proofPath, ...pago }) => ({ ...pago, tieneComprobante: Boolean(proofPath) }));
  },

  /**
   * La revisión previa, antes de enviar: la web la pide al elegir la imagen
   * para avisar si no parece un comprobante y, de paso, rellenar el número de
   * operación si lo lee. No guarda nada.
   */
  async revisarAntesDeEnviar({ buffer, metodo, monto }) {
    proofStorage.comprobarImagen(buffer);
    const revision = await revisarCaptura(buffer, { amountCents: monto, metodo });
    return {
      veredicto: revision.veredicto,
      operacionLeida: revision.operacionLeida ?? null,
      montoVisto: revision.montoVisto ?? null,
    };
  },

  contarPendientes() {
    return paymentRepository.countInReview();
  },

  /** La imagen del comprobante, para verla en el panel. */
  async comprobante(paymentId) {
    const payment = await paymentRepository.findByIdWithPlan(paymentId);
    if (!payment || !payment.proofPath) {
      throw new NotFoundError('Ese pago no tiene comprobante.');
    }

    return { buffer: await proofStorage.leer(payment.proofPath), mime: payment.proofMime };
  },

  /**
   * Da el pago por bueno y entrega lo comprado.
   *
   * Recorre el mismo camino que un cobro de PayPal —`entregarPago`—, así que una
   * licencia comprada por Yape sale idéntica a una comprada con tarjeta: mismos
   * topes, mismo modo de entrega, misma caducidad.
   *
   * Lo que devuelve NO incluye la URL del conector aunque la entrega la genere:
   * quien está mirando esta pantalla es el administrador, no el dueño de la
   * licencia.
   */
  async aprobar({ paymentId, adminId }) {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { plan: true, user: { select: COMPRADOR } },
    });

    if (!payment) throw new NotFoundError('No encontramos ese pago.');

    if (payment.status === 'PAID') {
      return { alreadyProcessed: true, payment: { id: payment.id, status: payment.status } };
    }

    if (payment.status !== 'IN_REVIEW') {
      throw new AppError(`Este pago está en estado ${payment.status}: no hay nada que aprobar.`, {
        statusCode: 409,
        code: ERROR_CODES.PAYMENT_FAILED,
      });
    }

    // Un carrito se aprueba entero: es un solo comprobante por la suma.
    if (payment.cartId) return aprobarCarrito({ cartId: payment.cartId, adminId });

    const entrega = await entregarPago({
      payment,
      estadoEsperado: 'IN_REVIEW',
      captura: capturaManual(payment, adminId),
      notaBolsa: `Pago por ${medioDelPago(payment).nombre} confirmado a mano`,
    });

    // Sin entrega: otro administrador lo aprobó un instante antes.
    if (!entrega) {
      return { alreadyProcessed: true, payment: { id: paymentId, status: 'PAID' } };
    }

    await paymentRepository.markReviewed(paymentId, adminId);

    logger.info(
      { paymentId, adminId, plan: payment.plan.code, userId: payment.userId },
      'Pago por Yape aprobado y producto entregado',
    );

    // El correo al comprador NO se manda aquí: lo manda `entregarPago`, que es
    // el mismo punto por el que pasa un cobro de pasarela. Antes salía desde
    // aquí y decía «entra al panel y pulsa Nueva URL»; ahora lleva la URL
    // dentro, y tenía que hacerlo igual viniera de Yape o de PayPal. Dos envíos
    // en dos sitios distintos era la forma segura de que un día dijeran cosas
    // distintas.

    return {
      alreadyProcessed: false,
      payment: { id: paymentId, status: 'PAID' },
      // Solo lo que el administrador necesita ver.
      entregado: loEntregado(payment.plan, entrega),
    };
  },

  /** Rechaza el comprobante. El motivo se le enseña al comprador tal cual. */
  async rechazar({ paymentId, adminId, motivo }) {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { plan: { select: { name: true } }, user: { select: COMPRADOR } },
    });

    if (!payment) throw new NotFoundError('No encontramos ese pago.');

    // Un carrito se rechaza entero, con un solo correo: es una sola captura.
    const filas = payment.cartId
      ? (await paymentRepository.findCart(payment.cartId)).filter((f) => f.status === 'IN_REVIEW')
      : [payment];
    const resultados = await Promise.all(
      filas.map((fila) =>
        paymentRepository.reject(fila.id, { reviewedById: adminId, reviewNote: motivo }),
      ),
    );
    const rechazado = resultados.some(Boolean);

    if (!rechazado) {
      throw new AppError(
        `Este pago está en estado ${payment.status}: ya no se puede rechazar.`,
        { statusCode: 409, code: ERROR_CODES.PAYMENT_FAILED },
      );
    }

    logger.warn({ paymentId, adminId, motivo }, 'Comprobante de Yape rechazado');

    avisar(
      payment.user.email,
      plantillas.manualPaymentRejected({
        firstName: payment.user.firstName,
        planName: payment.cartId
          ? carrito.nombreDelCarrito(filas.map((fila) => fila.plan))
          : payment.plan.name,
        motivo,
      }),
      { paymentId },
    );

    return { payment: { id: paymentId, status: 'REJECTED', reviewNote: motivo } };
  },
};

module.exports = manualService;

'use strict';

const crypto = require('node:crypto');
const env = require('../../config/env');
const logger = require('../../config/logger');
const { ERROR_CODES } = require('../../config/constants');
const { sendMail } = require('../../lib/mailer');
const plantillas = require('../../lib/emailTemplates');
const licenseRepository = require('./license.repository');
const { analizar, NIVELES } = require('./license.detector');
const limites = require('./license.limits');
const watch = require('./license.watch');
const prisma = require('../../lib/prisma');
const proofStorage = require('../payments/proof.storage');
const {
  generateOpaqueToken,
  hashToken,
  addDays,
} = require('../../shared/utils/tokens');
const { AppError, NotFoundError } = require('../../shared/errors/AppError');

/**
 * Alfabeto sin caracteres que se confunden al dictarlos por WhatsApp: fuera la
 * O y el 0, la I y el 1. El comprador va a teclear esto a mano.
 */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GRUPOS = 3;
const LARGO_GRUPO = 4;

/** Días de histórico que mira el detector. */
const VENTANA_ANALISIS_DIAS = 30;

function generarCodigo() {
  const grupos = [];
  for (let g = 0; g < GRUPOS; g += 1) {
    let grupo = '';
    for (let i = 0; i < LARGO_GRUPO; i += 1) {
      grupo += ALFABETO[crypto.randomInt(0, ALFABETO.length)];
    }
    grupos.push(grupo);
  }
  return `ACR-${grupos.join('-')}`;
}

/** Normaliza lo que teclea el comprador: mayúsculas y sin espacios sobrantes. */
function normalizarCodigo(codigo) {
  return codigo.trim().toUpperCase().replace(/\s+/g, '');
}

function urlDelConector(token) {
  return `${env.MCP_PUBLIC_URL.replace(/\/+$/, '')}/${token}`;
}

/**
 * Manda al comprador la URL que se acaba de emitir, sin bloquear el canje.
 *
 * Tiene que salir desde aquí y no desde el controlador porque el token en claro
 * solo existe dentro de esta función: en cuanto se devuelve, lo único que queda
 * en la base de datos es su SHA-256.
 *
 * Un fallo del correo no puede tumbar el canje —el código ya se gastó y la
 * licencia ya existe—, así que se registra y se sigue. Al comprador le queda la
 * URL en pantalla y «Nueva URL» en su panel.
 */
function avisarDeLaEntrega({ userId, planName, connectorUrl, expiresAt }) {
  prisma.user
    .findUnique({ where: { id: userId }, select: { email: true, firstName: true } })
    .then((usuario) => {
      if (!usuario?.email) return null;

      return sendMail({
        to: usuario.email,
        ...plantillas.licenseReady({
          firstName: usuario.firstName,
          planName,
          connectorUrl,
          expiresAt,
          via: 'codigo',
        }),
      });
    })
    .catch((error) => {
      logger.error({ err: error, userId }, 'No se pudo enviar el correo del canje');
    });
}

/** Mismo mensaje para código inexistente, ya usado o anulado: no se filtra cuál. */
function codigoInvalido(code = ERROR_CODES.LICENSE_CODE_INVALID) {
  return new AppError('Ese código no es válido o ya se usó.', { statusCode: 400, code });
}

/**
 * Lo que el plan define para una licencia: cuánto dura y con qué topes.
 *
 * Se lee UNA vez, al emitirla, y se copia a la licencia. Si mañana subes o bajas
 * los límites del plan, quien ya compró conserva los suyos: es lo que contrató.
 *
 * LA DURACIÓN SALE DEL PLAN, NO DEL .env
 * ---------------------------------------
 * Antes había dos fuentes: la compra por la web usaba `plan.durationDays` y el
 * canje de un código de activación usaba `LICENSE_DURATION_DAYS`. Con la
 * variable a 0, cada código que se repartía —a un cliente que pagó por
 * transferencia, a un colega, a un alumno de cortesía— entregaba acceso
 * VITALICIO de un producto que se vende por trimestres, y no había forma de
 * notarlo salvo mirando la fila en la base de datos.
 *
 * Ahora manda el plan y solo el plan. La variable de entorno queda como último
 * recurso, para un producto que no tenga plan asociado.
 */
async function contratoDelProducto(productCode) {
  const plan = await prisma.plan.findFirst({
    where: { kind: 'LICENSE', productCode, active: true },
    select: {
      id: true,
      name: true,
      priceCents: true,
      durationDays: true,
      mcpCallsPerDay: true,
      mcpCallsPerMonth: true,
      mcpCostCentsPerMonth: true,
      mcpCallsTotal: true,
      mcpCostCentsTotal: true,
      mcpDelivery: true,
    },
  });

  return {
    /** Fila del plan. Null si el producto no tiene ninguno: entonces no hay pago que registrar. */
    planId: plan?.id ?? null,
    /** Precio de catálogo, que es lo que se cobra salvo que se diga otra cosa. */
    priceCents: plan?.priceCents ?? 0,
    /** Cómo se llama lo comprado, para poder nombrarlo en el correo de entrega. */
    nombre: plan?.name ?? 'Método de tesis',
    /** Días de acceso. 0 = sin caducidad. */
    durationDays: plan?.durationDays ?? env.LICENSE_DURATION_DAYS,
    /** Se separan porque se vuelcan tal cual en la fila de la licencia. */
    topes: {
      callsPerDay: plan?.mcpCallsPerDay ?? 0,
      callsPerMonth: plan?.mcpCallsPerMonth ?? 0,
      costCentsPerMonth: plan?.mcpCostCentsPerMonth ?? 0,
      callsLimitTotal: plan?.mcpCallsTotal ?? 0,
      costCentsLimitTotal: plan?.mcpCostCentsTotal ?? 0,
      delivery: plan?.mcpDelivery ?? 'EXECUTED',
    },
  };
}

/**
 * Le manda el código al comprador, sin bloquear la generación.
 *
 * Solo sale si el administrador escribió un correo. Ese campo era «para tu
 * registro» y ahora además entrega: quien paga por Western Union o por una
 * transferencia no tiene cuenta todavía, así que el correo es la única
 * superficie que le alcanza, y dictar doce caracteres por WhatsApp es la forma
 * segura de que uno llegue mal escrito.
 *
 * Que falle el envío no puede tumbar nada: los códigos ya están creados y el
 * administrador los tiene en pantalla para copiarlos. Se registra y se sigue.
 */
function avisarDelCodigo({ buyerEmail, codigos, planName, expiresAt }) {
  sendMail({
    to: buyerEmail,
    ...plantillas.activationCode({ codes: codigos, planName, expiresAt }),
  }).catch((error) => {
    logger.error(
      { err: error, buyerEmail },
      'No se pudo enviar el código de activación al comprador',
    );
  });
}

/** Moneda de los cobros de fuera de la web: los precios se anuncian en soles. */
const MONEDA = 'PEN';

/**
 * El pago que hay que apuntar al canjear un código, o null si no hay ninguno.
 *
 * POR QUÉ EL PAGO NACE AQUÍ Y NO AL GENERAR EL CÓDIGO
 * ----------------------------------------------------
 * Un pago cuelga de una cuenta, y cuando el código se genera esa cuenta todavía
 * no existe: quien pagó por Western Union puede tardar días en registrarse. El
 * dinero se apunta en el código —que es donde el administrador lo sabe— y el
 * pago se materializa en el canje, que es el primer momento en que hay un
 * usuario al que colgárselo.
 *
 * La consecuencia hay que tenerla presente: una venta cobrada cuyo código nunca
 * se canjea no aparece en las cifras. Por eso la tabla de códigos del panel
 * enseña el importe junto al estado, que es donde se ve ese dinero en el aire.
 *
 * Devuelve null —y entonces no se apunta nada— en tres casos: una cortesía, un
 * código de los antiguos (sin estos campos) y un producto sin plan activo, que
 * no tiene precio ni fila a la que referirse.
 */
function pagoDelCodigo({ registro, contrato, userId }) {
  const metodo = registro.paymentMethod;

  if (!metodo || metodo === 'CORTESIA') return null;
  if (!contrato.planId) return null;

  const importe = registro.amountCents ?? contrato.priceCents;
  if (!importe || importe <= 0) return null;

  return {
    userId,
    planId: contrato.planId,
    provider: metodo,
    // La pareja (provider, providerOrderId) es única. El id del código sirve de
    // referencia y además impide que un mismo código apunte dos cobros.
    providerOrderId: registro.id,
    providerCaptureId: registro.paymentRef || registro.id,
    status: 'PAID',
    amountCents: importe,
    currency: MONEDA,
    payerEmail: registro.buyerEmail,
    // Mismo papel que en un Yape: es lo que permite cuadrarlo con el extracto.
    operationCode: registro.paymentRef,
    paidAt: new Date(),
    // Quién dio por bueno el cobro. No lo revisó una pantalla: lo cobró una
    // persona, la misma que generó el código.
    reviewedById: registro.createdById,
    reviewedAt: new Date(),
    rawResponse: JSON.stringify({
      via: 'CODIGO_DE_ACTIVACION',
      codigo: registro.hint,
      nota: registro.note,
      generadoEn: registro.createdAt,
    }),
  };
}

const licenseService = {
  /**
   * Genera códigos de un solo uso. Devuelve los códigos EN CLARO una única vez:
   * en la base de datos solo queda su hash, así que si no se copian ahora, se
   * pierden y hay que generar otros.
   *
   * Si se indica el correo del comprador, se le mandan también por ahí. La
   * pantalla del administrador los sigue enseñando igual: el correo puede
   * rebotar, y en ese caso lo único que queda es lo que se copió a mano.
   */
  async generateCodes({
    cantidad = 1,
    productCode,
    buyerEmail,
    note,
    createdById,
    expiresAt,
    paymentMethod = 'CORTESIA',
    paymentRef,
    amountCents,
  }) {
    const producto = productCode ?? env.LICENSE_PRODUCT_CODE;
    // Se lee siempre, no solo cuando hay que mandar correo: de aquí sale el
    // precio con el que se apunta el cobro.
    const contrato = await contratoDelProducto(producto);

    const cortesia = paymentMethod === 'CORTESIA';
    // Un regalo no cobra nada. Y si no se dijo cuánto, se cobró el precio de la
    // web: es lo que ocurre en la práctica y evita teclear la cifra dos veces.
    const cobrado = cortesia ? null : (amountCents ?? contrato.priceCents);

    const codigos = [];
    const ids = [];
    const filas = [];

    for (let i = 0; i < cantidad; i += 1) {
      const codigo = generarCodigo();
      codigos.push(codigo);

      // El identificador se genera aquí y no en la base de datos porque
      // `createMany` no devuelve las filas creadas, y hace falta saber a qué
      // código enganchar el comprobante que suba el administrador justo después.
      const id = crypto.randomUUID();
      ids.push(id);

      filas.push({
        id,
        codeHash: hashToken(codigo),
        // Los últimos 4 caracteres bastan para reconocerlo en el panel.
        hint: codigo.slice(-4),
        productCode: producto,
        buyerEmail,
        note,
        createdById,
        expiresAt,
        paymentMethod,
        paymentRef: paymentRef || null,
        amountCents: cobrado,
      });
    }

    await licenseRepository.createCodes(filas);
    logger.info(
      { cantidad, producto, buyerEmail, paymentMethod, amountCents: cobrado },
      'Códigos de activación generados',
    );

    if (buyerEmail) {
      // El nombre del plan sale del mismo sitio que en una compra, para que el
      // comprador lea lo mismo que vio en la web al pagar.
      avisarDelCodigo({ buyerEmail, codigos, planName: contrato.nombre, expiresAt });
    }

    return {
      productCode: producto,
      codes: codigos,
      // Los identificadores viajan para que el panel pueda adjuntarle el
      // comprobante al código recién creado, si el administrador subió uno.
      ids,
      enviadoA: buyerEmail ?? null,
      // Lo que se apuntó como cobro, para que el panel lo confirme en pantalla.
      // Un importe de cero se anuncia como lo que es —nada—, porque es lo que
      // hará el canje: sin dinero no se apunta ningún pago.
      cobro: cortesia || !cobrado ? null : { paymentMethod, amountCents: cobrado },
    };
  },

  /**
   * Guarda el comprobante de una venta cobrada fuera de la web.
   *
   * Es opcional a propósito: una cortesía no tiene captura, y una transferencia
   * que ya se vio en el extracto tampoco la necesita. Cuando la hay, es lo que
   * permite reconstruir meses después de dónde salió ese dinero, que es
   * exactamente lo que se pregunta cuando algo no cuadra.
   *
   * La imagen va a la misma carpeta que los comprobantes de Yape: es el mismo
   * tipo de dato con el mismo problema —pesa, hay que conservarla y no debe
   * vivir en la base de datos—, así que no merecía un almacén propio.
   */
  async adjuntarComprobante(id, buffer) {
    const codigo = await prisma.activationCode.findUnique({
      where: { id },
      select: { id: true, proofPath: true },
    });
    if (!codigo) throw new NotFoundError('Ese código no existe.');

    const guardado = await proofStorage.guardar(buffer, { paymentId: `codigo-${id}` });

    // Si ya tenía una, se sustituye y la anterior se borra: dos capturas del
    // mismo cobro solo sirven para dudar de cuál era la buena.
    if (codigo.proofPath) await proofStorage.borrar(codigo.proofPath);

    await prisma.activationCode.update({
      where: { id },
      data: { proofPath: guardado.path, proofMime: guardado.mime },
    });

    logger.info({ codeId: id }, 'Comprobante adjuntado a un código de activación');
    return { mime: guardado.mime };
  },

  /** La imagen del comprobante, para verla en el panel. */
  async comprobanteDe(id) {
    const codigo = await prisma.activationCode.findUnique({
      where: { id },
      select: { proofPath: true, proofMime: true },
    });

    if (!codigo?.proofPath) throw new NotFoundError('Ese código no tiene comprobante.');

    return { buffer: await proofStorage.leer(codigo.proofPath), mime: codigo.proofMime };
  },

  /**
   * Canjea un código y entrega la licencia con su URL de conector.
   *
   * La URL lleva el token dentro, así que el comprador puede verla y, si quiere,
   * reenviarla. Eso no se puede impedir; se detecta después por el patrón de uso
   * (ver `license.detector.js`) y se corta revocando.
   */
  async redeemCode({ userId, code }) {
    const normalizado = normalizarCodigo(code);
    const registro = await licenseRepository.findCodeByHash(hashToken(normalizado));

    if (!registro) throw codigoInvalido();

    if (registro.status === 'REDEEMED') {
      throw codigoInvalido(ERROR_CODES.LICENSE_CODE_USED);
    }

    if (registro.status === 'VOID') throw codigoInvalido();

    if (registro.expiresAt && registro.expiresAt <= new Date()) {
      throw new AppError('Ese código caducó. Escríbenos y te damos uno nuevo.', {
        statusCode: 400,
        code: ERROR_CODES.LICENSE_CODE_INVALID,
      });
    }

    // Duración y topes salen del plan del producto, igual que en una compra.
    const contrato = await contratoDelProducto(registro.productCode);

    const token = generateOpaqueToken(32);
    const licencia = await licenseRepository.redeem({
      codeId: registro.id,
      // El cobro que se apuntó al generar el código. Se pasa al repositorio para
      // que el pago nazca dentro de la misma transacción que la licencia: o
      // quedan las dos cosas o no queda ninguna. Un canje que entregara el
      // acceso sin apuntar el dinero es exactamente el agujero que esto cierra.
      pago: pagoDelCodigo({ registro, contrato, userId }),
      datosLicencia: {
        userId,
        productCode: registro.productCode,
        tokenHash: hashToken(token),
        tokenHint: token.slice(0, 8),
        expiresAt:
          contrato.durationDays > 0 ? addDays(new Date(), contrato.durationDays) : null,
        ...contrato.topes,
      },
    });

    // Sin licencia: otra petición canjeó el mismo código un instante antes.
    if (!licencia) throw codigoInvalido(ERROR_CODES.LICENSE_CODE_USED);

    logger.info(
      { userId, licenseId: licencia.id, producto: registro.productCode },
      'Código canjeado: licencia activada',
    );

    const url = urlDelConector(token);

    // El mismo correo que recibe quien compra por la web. Un canje es una
    // entrega igual que un cobro, y la URL solo existe en este instante: si no
    // sale ahora, el único sitio donde queda es la pantalla que el comprador
    // tiene delante.
    avisarDeLaEntrega({
      userId,
      planName: contrato.nombre,
      connectorUrl: url,
      expiresAt: licencia.expiresAt,
    });

    return { license: licencia, connectorUrl: url };
  },

  /**
   * Prepara una licencia para una compra pagada por la web.
   *
   * Devuelve los datos para crearla y la URL ya montada, pero no la guarda: de
   * eso se encarga la transacción del cobro, para que la licencia y el pago se
   * confirmen juntos o no se confirme ninguno.
   */
  async prepareForPurchase({ userId, productCode }) {
    // La duración ya NO llega por parámetro: la decide el plan, para que compra
    // y canje no puedan discrepar nunca.
    const { durationDays, topes } = await contratoDelProducto(productCode);

    // ¿Está renovando? Si ya tiene una licencia de este mismo grupo y no está
    // revocada, se le alarga esa en vez de emitirle otra. Emitir una nueva le
    // dejaría dos conectores en Claude —uno de ellos muerto— y le obligaría a
    // reinstalar cada trimestre, que es la forma más rápida de que no renueve.
    //
    // Una revocada no cuenta: pagar de nuevo no puede deshacer una revocación
    // por uso compartido. En ese caso se emite una limpia y la vieja se queda
    // como está, con su motivo.
    const vigente = await prisma.license.findFirst({
      where: { userId, productCode, status: { not: 'REVOKED' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, expiresAt: true },
    });

    if (vigente) {
      // Se cuenta desde la caducidad actual si aún no ha llegado, y desde hoy
      // si ya pasó: renovar con margen no debe costarle los días que le
      // quedaban. Una licencia sin caducidad —de las vendidas «de por vida»—
      // se queda sin caducidad: pagar no puede empeorar lo que ya tenía.
      const sinCaducidad = vigente.expiresAt === null;
      const desde = vigente.expiresAt > new Date() ? vigente.expiresAt : new Date();

      return {
        renovacion: {
          licenseId: vigente.id,
          expiresAt: sinCaducidad || durationDays === 0 ? null : addDays(desde, durationDays),
          topes,
        },
      };
    }

    const token = generateOpaqueToken(32);

    return {
      data: {
        userId,
        productCode,
        tokenHash: hashToken(token),
        tokenHint: token.slice(0, 8),
        expiresAt: durationDays > 0 ? addDays(new Date(), durationDays) : null,
        ...topes,
      },
      connectorUrl: urlDelConector(token),
    };
  },

  /**
   * Valida el token que viene en la URL del conector. Es la puerta de entrada
   * del MCP, así que se comprueba todo aquí: existe, está activa, no ha caducado
   * y la cuenta del dueño sigue en pie.
   */
  async authenticate(token) {
    if (!token) {
      throw new AppError('Falta la licencia.', {
        statusCode: 401,
        code: ERROR_CODES.LICENSE_INVALID,
      });
    }

    const licencia = await licenseRepository.findByTokenHash(hashToken(token));

    if (!licencia) {
      throw new AppError('Esta licencia no existe.', {
        statusCode: 401,
        code: ERROR_CODES.LICENSE_INVALID,
      });
    }

    if (licencia.status !== 'ACTIVE') {
      throw new AppError('Esta licencia está desactivada. Escríbenos si crees que es un error.', {
        statusCode: 403,
        code: ERROR_CODES.LICENSE_REVOKED,
      });
    }

    if (licencia.expiresAt && licencia.expiresAt <= new Date()) {
      throw new AppError('Esta licencia caducó.', {
        statusCode: 403,
        code: ERROR_CODES.LICENSE_REVOKED,
      });
    }

    if (licencia.user.status !== 'ACTIVE') {
      throw new AppError('La cuenta asociada a esta licencia no está activa.', {
        statusCode: 403,
        code: ERROR_CODES.LICENSE_REVOKED,
      });
    }

    return licencia;
  },

  /**
   * Anota la llamada. Nunca lanza: si falla el registro de uso no se le puede
   * negar el servicio a un cliente que sí pagó.
   */
  async recordUsage({
    licenseId,
    tool,
    prompt,
    sessionId,
    ok = true,
    durationMs,
    kind = 'NORMAL',
    inputTokens = 0,
    outputTokens = 0,
    cachedTokens = 0,
    costCents = 0,
    cuentaParaElTope = false,
  }) {
    try {
      await licenseRepository.recordUsage({
        licenseId,
        tool,
        // Solo el hash: sirve para comparar consultas entre sí sin conservar
        // lo que escribió el tesista, que es material de su tesis.
        promptHash: prompt ? hashToken(prompt) : null,
        sessionId: sessionId ?? null,
        ok,
        durationMs,
        kind,
        inputTokens,
        outputTokens,
        cachedTokens,
        costCents,
      });

      // Las consultas baratas (catálogo, estado) se registran pero no gastan
      // cupo: sería absurdo que alguien se quedara sin capítulos por haber
      // mirado la lista tres veces.
      if (cuentaParaElTope) {
        await limites.registrar(licenseId, { costCents });
      }
    } catch (error) {
      logger.error({ err: error, licenseId }, 'No se pudo registrar el uso de la licencia');
    }

    // La vigilancia va aparte y sin await: si tarda o falla, el tesista ya
    // tiene su respuesta. Ella misma se salta si revisó hace poco.
    watch.evaluar(licenseId).catch(() => undefined);
  },

  /** ¿Le queda cupo a esta licencia? Se consulta ANTES de gastar tokens. */
  checkLimits(licencia) {
    return limites.comprobar(licencia);
  },

  usageSummary(licencia) {
    return limites.resumen(licencia);
  },

  listAlerts(licenseId) {
    return watch.listarAlertas(licenseId);
  },

  openAlerts() {
    return watch.alertasAbiertas();
  },

  /**
   * Licencias del comprador con su consumo ya normalizado.
   *
   * El contador guardado puede ser de ayer; aquí se traduce a lo que de verdad
   * lleva consumido hoy, para que el panel no muestre un número caducado.
   */
  async listForUser(userId) {
    const licencias = await licenseRepository.listForUser(userId);
    const dia = limites.selloDia();
    const mes = limites.selloMes();

    return licencias.map(({ counter, ...licencia }) => ({
      ...licencia,
      usage: {
        callsToday: counter?.dayStamp === dia ? counter.callsToday : 0,
        callsMonth: counter?.monthStamp === mes ? counter.callsMonth : 0,
        costCentsMonth: counter?.monthStamp === mes ? counter.costCentsMonth : 0,
      },
    }));
  },

  /**
   * Genera una URL nueva para una licencia y anula la anterior.
   *
   * Hace falta porque del token solo se guarda el hash: si el comprador pierde
   * la URL, no hay forma de volver a mostrársela. Rotar también es la salida
   * cuando sospecha que se la copiaron, sin tener que revocarle el acceso.
   */
  async rotate({ licenseId, userId }) {
    const licencia = await licenseRepository.findOwned(licenseId, userId);
    if (!licencia) throw new NotFoundError('No encontramos esa licencia.');

    if (licencia.status !== 'ACTIVE') {
      throw new AppError('Esta licencia está desactivada; no se le puede generar una URL nueva.', {
        statusCode: 409,
        code: ERROR_CODES.LICENSE_REVOKED,
      });
    }

    const token = generateOpaqueToken(32);
    const actualizada = await licenseRepository.replaceToken(licenseId, {
      tokenHash: hashToken(token),
      tokenHint: token.slice(0, 8),
    });

    logger.info({ licenseId, userId }, 'URL del conector regenerada');
    return { license: actualizada, connectorUrl: urlDelConector(token) };
  },

  listAll(filtros) {
    return licenseRepository.listAll(filtros);
  },

  /** Ficha completa de una licencia: estado, uso reciente y diagnóstico. */
  async inspect(id) {
    const licencia = await licenseRepository.findById(id);
    if (!licencia) throw new NotFoundError('No encontramos esa licencia.');

    const desde = addDays(new Date(), -VENTANA_ANALISIS_DIAS);
    const usos = await licenseRepository.usagesSince(id, desde);

    return {
      license: licencia,
      diagnostico: analizar(usos),
      usosRecientes: await licenseRepository.recentUsages(id),
    };
  },

  /**
   * Revisa todas las licencias activas y devuelve las que pintan mal.
   *
   * A propósito NO revoca nada por su cuenta. Una revocación automática por una
   * señal estadística puede dejar tirado a un cliente legítimo en plena semana
   * de sustentación; que la última palabra la tenga una persona sale más barato
   * que perder a un comprador que sí pagó.
   */
  async review({ limit = 200 } = {}) {
    const licencias = await licenseRepository.listAll({ status: 'ACTIVE', limit });
    const desde = addDays(new Date(), -VENTANA_ANALISIS_DIAS);
    const hallazgos = [];

    for (const licencia of licencias) {
      const usos = await licenseRepository.usagesSince(licencia.id, desde);
      const diagnostico = analizar(usos);

      if (diagnostico.nivel !== NIVELES.NORMAL) {
        hallazgos.push({ license: licencia, diagnostico });
      }
    }

    // Primero lo más grave.
    hallazgos.sort((a, b) => (a.diagnostico.nivel === NIVELES.SOSPECHA_ALTA ? -1 : 1));
    return hallazgos;
  },

  async revoke(id, reason) {
    const licencia = await licenseRepository.findById(id);
    if (!licencia) throw new NotFoundError('No encontramos esa licencia.');

    const actualizada = await licenseRepository.setStatus(id, {
      status: 'REVOKED',
      revokedReason: reason,
    });

    logger.warn({ licenseId: id, reason }, 'Licencia revocada');
    return actualizada;
  },

  async reactivate(id) {
    const licencia = await licenseRepository.findById(id);
    if (!licencia) throw new NotFoundError('No encontramos esa licencia.');

    logger.info({ licenseId: id }, 'Licencia reactivada');
    return licenseRepository.setStatus(id, { status: 'ACTIVE' });
  },

  listCodes(filtros) {
    return licenseRepository.listCodes(filtros);
  },

  async voidCode(id) {
    const { count } = await licenseRepository.voidCode(id);
    if (count === 0) {
      throw new AppError('Ese código ya se canjeó o ya estaba anulado.', {
        statusCode: 409,
        code: ERROR_CODES.LICENSE_CODE_USED,
      });
    }
  },
};

module.exports = licenseService;

// Se expone aparte de la API del servicio, y a propósito: es una función pura y
// es la que decide si una venta se apunta o se pierde, así que conviene poder
// probarla sin una base de datos delante.
module.exports.pagoDelCodigo = pagoDelCodigo;

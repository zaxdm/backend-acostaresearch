'use strict';

const prisma = require('../../lib/prisma');
const env = require('../../config/env');
const logger = require('../../config/logger');
const { AppError, NotFoundError } = require('../../shared/errors/AppError');
const proofStorage = require('./proof.storage');

/**
 * Los medios de pago de la casa, vistos desde el panel.
 *
 * Yape y Western Union tienen sus datos en el `.env`, y Hotmart y Culqi se
 * encienden solos cuando tienen llaves. Eso sigue siendo así: aquí solo se
 * guarda lo que el dueño cambie encima —apagar uno, otro titular, otro QR—, en
 * una fila por medio. Sin fila, o con un campo vacío, manda el `.env`, de modo
 * que desplegar esto no cambia nada hasta que alguien toca algo.
 *
 * Apagar un medio lo quita del checkout y nada más: lo ya pagado por él se
 * sigue revisando y entregando, y el webhook de Hotmart sigue escuchando.
 *
 * Las llaves no están aquí ni se cambian desde el panel: siguen en el `.env`.
 */

const YAPE = 'YAPE';
const WESTERN_UNION = 'WESTERN_UNION';
const HOTMART = 'HOTMART';
const CULQI = 'CULQI';

/** Los que tienen datos que enseñar al comprador, y por tanto que editar. */
const CON_DATOS = [YAPE, WESTERN_UNION];

/**
 * Las filas guardadas, por código.
 *
 * Si la tabla falla —la migración aún no corrió, la base no contesta— se sigue
 * como si no hubiera ninguna: el checkout no puede quedarse sin medios de pago
 * por un ajuste del panel.
 */
async function filas() {
  try {
    const guardadas = await prisma.medioDePago.findMany();
    return new Map(guardadas.map((fila) => [fila.codigo, fila]));
  } catch (error) {
    logger.warn({ err: error }, 'No se pudieron leer los medios de pago del panel; manda el .env');
    return new Map();
  }
}

const version = (fila) => (fila?.qrPath ? new Date(fila.updatedAt).getTime() : null);

/** Un medio tal como lo enseña el panel. `configurado` = tiene lo suyo en el `.env`. */
function presentar(codigo, fila) {
  const active = fila ? fila.active : true;
  const wu = env.westernUnion;

  switch (codigo) {
    case YAPE:
      return {
        codigo,
        nombre: 'Yape',
        pais: 'PE',
        moneda: 'PEN',
        active,
        editable: true,
        titular: fila?.titular ?? env.yape.titular,
        numero: fila?.numero ?? env.yape.numero,
        ciudad: null,
        // Sin QR subido, el checkout enseña el de siempre, el de la web.
        tieneQr: Boolean(fila?.qrPath),
        qrVersion: version(fila),
      };
    case WESTERN_UNION:
      return {
        codigo,
        nombre: 'Western Union',
        pais: null,
        moneda: 'USD',
        active,
        editable: true,
        titular: fila?.titular ?? wu.beneficiario,
        numero: fila?.numero ?? wu.dni,
        ciudad: fila?.ciudad ?? wu.ciudad,
        tieneQr: false,
        qrVersion: null,
      };
    default:
      return {
        codigo,
        nombre: codigo === HOTMART ? 'Hotmart' : 'Culqi (tarjeta o Yape al instante)',
        pais: null,
        moneda: codigo === HOTMART ? 'USD' : 'PEN',
        active,
        editable: false,
        titular: null,
        numero: null,
        ciudad: null,
        tieneQr: false,
        qrVersion: null,
      };
  }
}

/** Los que existen de verdad: Yape siempre; los demás, si tienen lo suyo en el `.env`. */
function configurados() {
  return [
    YAPE,
    ...(env.westernUnion.activo ? [WESTERN_UNION] : []),
    ...(env.hotmartEnabled ? [HOTMART] : []),
    ...(env.culqiEnabled ? [CULQI] : []),
  ];
}

function exigirConfigurado(codigo) {
  if (!configurados().includes(codigo)) {
    throw new NotFoundError('Ese medio de pago no está configurado en el servidor.');
  }
}

const medioService = {
  YAPE,
  WESTERN_UNION,
  HOTMART,
  CULQI,

  /** Todos, para el panel del dueño. */
  async listar() {
    const guardadas = await filas();
    return configurados().map((codigo) => presentar(codigo, guardadas.get(codigo)));
  },

  /**
   * Lo que cambia el panel sobre lo que dice el `.env`, para el checkout.
   *
   * `yape` y `westernUnion` llegan como los arma `manual.service` desde el
   * `.env` (`westernUnion` en null si no se ofrece) y salen con los datos del
   * panel encima; `westernUnion` sale en null si se apagó. `apagados` son los
   * códigos que no hay que ofrecer.
   */
  async paraElCheckout({ yape, westernUnion }) {
    const guardadas = await filas();
    const apagados = [...guardadas.values()].filter((f) => !f.active).map((f) => f.codigo);

    const filaYape = guardadas.get(YAPE);
    const filaWu = guardadas.get(WESTERN_UNION);

    return {
      yape: {
        ...yape,
        titular: filaYape?.titular ?? yape.titular,
        numero: filaYape?.numero ?? yape.numero,
        activo: !apagados.includes(YAPE),
        qrVersion: version(filaYape),
      },
      westernUnion:
        westernUnion && !apagados.includes(WESTERN_UNION)
          ? {
              ...westernUnion,
              beneficiario: filaWu?.titular ?? westernUnion.beneficiario,
              dni: filaWu?.numero ?? westernUnion.dni,
              ciudad: filaWu?.ciudad ?? westernUnion.ciudad,
            }
          : null,
      apagados,
    };
  },

  /** Los códigos apagados desde el panel: las pasarelas que no hay que ofrecer. */
  async apagados() {
    const guardadas = await filas();
    return new Set([...guardadas.values()].filter((f) => !f.active).map((f) => f.codigo));
  },

  /**
   * Enciende o apaga un medio, o cambia sus datos. Cada campo solo se toca si
   * viene. De Hotmart y Culqi solo se puede cambiar si se ofrecen.
   */
  async cambiar(codigo, { active, titular, numero, ciudad }, adminId) {
    exigirConfigurado(codigo);

    const datos = {
      ...(active === undefined ? {} : { active }),
      ...(CON_DATOS.includes(codigo) && titular !== undefined ? { titular } : {}),
      ...(CON_DATOS.includes(codigo) && numero !== undefined ? { numero } : {}),
      ...(codigo === WESTERN_UNION && ciudad !== undefined ? { ciudad } : {}),
      updatedById: adminId,
    };

    const fila = await prisma.medioDePago.upsert({
      where: { codigo },
      create: { codigo, ...datos },
      update: datos,
    });
    logger.warn({ codigo, adminId, active: fila.active }, 'Medio de pago de la casa cambiado desde el panel');
    return presentar(codigo, fila);
  },

  /**
   * Guarda la imagen del QR de Yape, o la cambia por otra. Va con los
   * comprobantes, como el de las billeteras de país; la anterior se borra
   * después de apuntar la nueva.
   */
  async guardarQr(codigo, buffer, adminId) {
    if (codigo !== YAPE) {
      throw new AppError('Ese medio de pago no lleva QR.', { statusCode: 400 });
    }

    const actual = await prisma.medioDePago.findUnique({ where: { codigo } });
    const guardado = await proofStorage.guardar(buffer, { paymentId: `qr-${codigo.toLowerCase()}` });
    const qr = { qrPath: guardado.path, qrMime: guardado.mime, updatedById: adminId };
    const fila = await prisma.medioDePago.upsert({
      where: { codigo },
      create: { codigo, ...qr },
      update: qr,
    });
    if (actual?.qrPath) await proofStorage.borrar(actual.qrPath);

    logger.warn({ codigo, adminId, bytes: guardado.bytes }, 'QR de un medio de pago de la casa guardado');
    return presentar(codigo, fila);
  },

  /** La imagen del QR subido desde el panel. Pública, como la de la web. */
  async qr(codigo) {
    const fila = await prisma.medioDePago.findUnique({
      where: { codigo },
      select: { qrPath: true, qrMime: true },
    });
    if (!fila?.qrPath) throw new NotFoundError('Ese medio de pago no tiene QR subido.');
    return { buffer: await proofStorage.leer(fila.qrPath), mime: fila.qrMime };
  },
};

module.exports = medioService;

'use strict';

const logger = require('../../config/logger');
const { sendMail } = require('../../lib/mailer');
const plantillas = require('../../lib/emailTemplates');
const billingService = require('../billing/billing.service');
const discountService = require('../billing/discount.service');
const licenseService = require('../licensing/license.service');
const licenseRepository = require('../licensing/license.repository');
const paymentRepository = require('./payment.repository');

/**
 * Avisa al comprador de lo que acaba de recibir, sin bloquear.
 *
 * Un fallo del correo no puede tumbar nada: para cuando esto se ejecuta, el
 * cobro ya está confirmado y lo comprado ya está entregado en la base de datos.
 * Se registra en el log —que es donde se mira si alguien reclama que no le
 * llegó— y se sigue.
 *
 * El caso de la licencia es el delicado: ese correo lleva la URL del conector y
 * es el único sitio donde esa URL vuelve a existir, porque del token solo se
 * guarda el hash. Si el envío falla, al comprador le queda «Nueva URL» en su
 * panel; por eso ese botón no se quita.
 */
function avisarAlComprador(payment, entrega) {
  const usuario = payment.user;

  if (!usuario?.email) {
    logger.warn({ paymentId: payment.id }, 'Entrega sin correo del comprador: no se avisa');
    return;
  }

  // Yape se aprueba a mano y horas después; una pasarela cobra al instante. El
  // correo lo dice de forma distinta en cada caso.
  const via = payment.provider === 'YAPE' ? 'yape' : 'online';
  const datos = { firstName: usuario.firstName, planName: payment.plan.name, via };

  let mensaje;

  if (entrega.license) {
    mensaje = entrega.renovada
      ? plantillas.licenseRenewed({ ...datos, expiresAt: entrega.license.expiresAt })
      : plantillas.licenseReady({
          ...datos,
          connectorUrl: entrega.connectorUrl,
          expiresAt: entrega.license.expiresAt,
        });
  } else if (entrega.pack) {
    mensaje = plantillas.wordsReady({
      ...datos,
      words: entrega.pack.wordsTotal,
      expiresAt: entrega.pack.expiresAt,
    });
  } else {
    return;
  }

  sendMail({ to: usuario.email, ...mensaje }).catch((error) => {
    logger.error(
      { err: error, paymentId: payment.id, userId: payment.userId },
      'No se pudo enviar el correo de entrega al comprador',
    );
  });
}

/**
 * Lo que se entrega cuando un pago se da por bueno.
 *
 * Vive aparte porque ahora hay DOS caminos que llegan aquí —el cobro de PayPal
 * y la aprobación a mano de un Yape— y tienen que entregar exactamente lo
 * mismo. Duplicar este bloque era la forma segura de que dentro de un mes una
 * licencia comprada por Yape saliera con topes distintos que la misma comprada
 * con tarjeta.
 *
 * Todo lo que toca la base de datos va dentro de la transacción de `settle`:
 * o el pago queda cobrado y lo comprado entregado, o no ocurre ninguna de las
 * dos cosas. Lo único que se hace fuera es preparar la licencia, porque su
 * token tiene que generarse una sola vez para poder devolver la URL.
 */
async function entregarPago({ payment, captura, estadoEsperado = 'PENDING', notaBolsa }) {
  const esLicencia = payment.plan.kind === 'LICENSE';

  const licenciaPreparada = esLicencia
    ? await licenseService.prepareForPurchase({
        userId: payment.userId,
        productCode: payment.plan.productCode ?? payment.plan.code,
        // La duración no se pasa: la resuelve el propio servicio desde el plan.
      })
    : null;

  const entrega = await paymentRepository.settle({
    paymentId: payment.id,
    estadoEsperado,
    captura,
    entregar: async (tx) => {
      // El código solo se gasta si el pago llegó a confirmarse.
      if (payment.discountCodeId) {
        await discountService.registrarUso(payment.discountCodeId, tx);
      }

      if (esLicencia) {
        // Renovar alarga la licencia que ya tiene; comprar por primera vez
        // emite una nueva. La diferencia la decidió `prepareForPurchase`.
        //
        // En una renovación NO se devuelve `connectorUrl`, y es a propósito:
        // el token no cambia, así que la URL que el comprador ya tiene sigue
        // siendo la buena. Mandarle una nueva le haría pensar que la anterior
        // dejó de servir.
        if (licenciaPreparada.renovacion) {
          const { licenseId, expiresAt, topes } = licenciaPreparada.renovacion;
          const license = await licenseRepository.extend(licenseId, { expiresAt, topes }, tx);
          return {
            enlace: { licenseId: license.id },
            resultado: { license, renovada: true },
          };
        }

        const license = await licenseRepository.create(licenciaPreparada.data, tx);
        return {
          enlace: { licenseId: license.id },
          resultado: { license, connectorUrl: licenciaPreparada.connectorUrl },
        };
      }

      const pack = await tx.wordPack.create({
        data: billingService.packDataForPlan({
          userId: payment.userId,
          plan: payment.plan,
          paymentMethod: payment.provider,
          paymentRef: captura.captureId,
          note: notaBolsa,
        }),
      });

      return { enlace: { wordPackId: pack.id }, resultado: { pack } };
    },
  });

  // El aviso va FUERA de la transacción a propósito: solo se avisa de lo que ya
  // está cerrado en la base de datos. Y solo si hubo entrega —si `settle`
  // devolvió null, otra petición cobró este pago un instante antes y el correo
  // ya salió con ella, así que aquí no se manda un duplicado.
  if (entrega) avisarAlComprador(payment, entrega);

  return entrega;
}

module.exports = { entregarPago };

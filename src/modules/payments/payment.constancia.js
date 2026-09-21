'use strict';

const PDFDocument = require('pdfkit');
const env = require('../../config/env');

/**
 * Constancia de pago en PDF.
 *
 * NO es una boleta ni una factura: no pasa por SUNAT y lo dice en el propio
 * documento. Es la prueba de que el pago entró y de qué se compró, para quien
 * la pide a su universidad, a su empresa o para sus cuentas. El día que haya
 * RUC y proveedor de comprobantes electrónicos, este módulo es el que se
 * cambia (o convive con la boleta).
 *
 * Se genera al vuelo desde la fila del pago, sin guardar nada: así sirve
 * también para los pagos anteriores a que existiera, y el número sale siempre
 * igual porque se deriva del propio pago.
 */

const EMISOR = 'Acosta | IA & Research';
const ZONA = 'America/Lima';

const MEDIOS = {
  PAYPAL: 'PayPal',
  CULQI: 'Tarjeta o Yape (Culqi)',
  YAPE: 'Yape',
  PLIN: 'Plin',
  TRANSFERENCIA: 'Transferencia bancaria',
  WESTERN_UNION: 'Western Union',
};

const COLOR_TEXTO = '#1f2933';
const COLOR_TENUE = '#6b7280';
const COLOR_LINEA = '#d9dee4';
const COLOR_MARCA = '#1e3a5f';

/** Solo tiene constancia un pago cobrado de verdad: no una cortesía a S/ 0. */
function tieneConstancia(payment) {
  return payment?.status === 'PAID' && payment.amountCents > 0 && Boolean(payment.paidAt);
}

/** Fecha en Lima como AAAAMMDD, para el número. */
function fechaCompacta(fecha) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(fecha);
  return partes.replaceAll('-', '');
}

/**
 * Número de la constancia: `CP-20260921-1A2B3C4D`. La fecha de pago más el
 * comienzo del identificador del pago. Estable: la misma constancia descargada
 * dos veces, o la del correo y la de la web, llevan el mismo número.
 */
function numeroDeConstancia(payment) {
  const sufijo = payment.id.replaceAll('-', '').slice(0, 8).toUpperCase();
  return `CP-${fechaCompacta(new Date(payment.paidAt))}-${sufijo}`;
}

function fechaLarga(fecha) {
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: ZONA,
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(new Date(fecha));
}

function importe(cents, moneda) {
  const simbolo = moneda === 'USD' ? 'US$' : moneda === 'PEN' ? 'S/' : moneda;
  const cifra = new Intl.NumberFormat('es-PE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
  return `${simbolo} ${cifra}`;
}

/** Qué se compró, en una línea: el plan y lo que trae. */
function concepto(plan) {
  const detalles = [];
  if (plan.words > 0) detalles.push(`${new Intl.NumberFormat('es-PE').format(plan.words)} palabras`);
  if (plan.durationDays > 0) detalles.push(`${plan.durationDays} días de acceso`);
  return detalles.length > 0 ? `${plan.name} (${detalles.join(', ')})` : plan.name;
}

function nombreDelCliente(user) {
  const nombre = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
  return nombre || user?.email || 'Cliente';
}

/** El identificador que el cliente puede cotejar con su banco o su app. */
function referenciaDeOperacion(payment) {
  return payment.operationCode ?? payment.providerCaptureId ?? null;
}

/**
 * Los datos que lleva la constancia, ya en texto. Separado del dibujo para
 * poder probarlo sin abrir el PDF.
 */
function datosDeConstancia(payment) {
  const subtotal = payment.amountCents + (payment.discountCents ?? 0);
  return {
    numero: numeroDeConstancia(payment),
    fechaDePago: fechaLarga(payment.paidAt),
    cliente: nombreDelCliente(payment.user),
    correo: payment.user?.email ?? payment.payerEmail ?? null,
    concepto: concepto(payment.plan),
    medio: MEDIOS[payment.provider] ?? payment.provider,
    referencia: referenciaDeOperacion(payment),
    subtotal: importe(subtotal, payment.currency),
    descuento:
      payment.discountCents > 0
        ? `- ${importe(payment.discountCents, payment.currency)}${
            payment.discountCode?.code ? ` (código ${payment.discountCode.code})` : ''
          }`
        : null,
    total: importe(payment.amountCents, payment.currency),
  };
}

/** Dibuja la constancia y devuelve el PDF como Buffer. */
function generarConstancia(payment) {
  const datos = datosDeConstancia(payment);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 56,
      info: {
        Title: `Constancia de pago ${datos.numero}`,
        Author: EMISOR,
        Subject: 'Constancia de pago',
      },
    });

    const partes = [];
    doc.on('data', (parte) => partes.push(parte));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);

    const izquierda = doc.page.margins.left;
    const ancho = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const linea = () => {
      doc.moveDown(0.6);
      doc
        .moveTo(izquierda, doc.y)
        .lineTo(izquierda + ancho, doc.y)
        .lineWidth(0.8)
        .strokeColor(COLOR_LINEA)
        .stroke();
      doc.moveDown(0.8);
    };

    // Cabecera
    doc.font('Helvetica-Bold').fontSize(18).fillColor(COLOR_MARCA).text(EMISOR, izquierda);
    doc
      .font('Helvetica')
      .fontSize(9.5)
      .fillColor(COLOR_TENUE)
      .text(env.APP_URL.replace(/^https?:\/\//, ''));
    if (env.MAIL_REPLY_TO) doc.text(env.MAIL_REPLY_TO);

    doc.moveDown(1.4);
    doc.font('Helvetica-Bold').fontSize(15).fillColor(COLOR_TEXTO).text('Constancia de pago');
    doc.font('Helvetica').fontSize(10.5).fillColor(COLOR_TENUE).text(`N.º ${datos.numero}`);
    linea();

    // Filas de etiqueta y valor
    const fila = (etiqueta, valor, { negrita = false } = {}) => {
      if (!valor) return;
      const y = doc.y;
      doc.font('Helvetica').fontSize(10.5).fillColor(COLOR_TENUE).text(etiqueta, izquierda, y, {
        width: 150,
      });
      doc
        .font(negrita ? 'Helvetica-Bold' : 'Helvetica')
        .fillColor(COLOR_TEXTO)
        .text(valor, izquierda + 160, y, { width: ancho - 160 });
      doc.moveDown(0.5);
    };

    fila('Fecha de pago', datos.fechaDePago);
    fila('Cliente', datos.cliente);
    fila('Correo', datos.correo);
    linea();

    fila('Concepto', datos.concepto);
    fila('Medio de pago', datos.medio);
    fila('N.º de operación', datos.referencia);
    linea();

    fila('Precio', datos.subtotal);
    fila('Descuento', datos.descuento);
    doc.moveDown(0.2);
    fila('Total pagado', datos.total, { negrita: true });
    linea();

    // Aviso
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(COLOR_TENUE)
      .text(
        'Este documento acredita que el pago fue recibido y confirmado. Es una constancia ' +
          'interna y no reemplaza a una boleta ni a una factura electrónica emitida ante SUNAT.',
        izquierda,
        doc.y,
        { width: ancho },
      );

    doc.end();
  });
}

/** Nombre del archivo que ve el cliente al descargarlo o en el correo. */
function nombreDeArchivo(payment) {
  return `constancia-de-pago-${numeroDeConstancia(payment)}.pdf`;
}

module.exports = {
  tieneConstancia,
  numeroDeConstancia,
  datosDeConstancia,
  generarConstancia,
  nombreDeArchivo,
};

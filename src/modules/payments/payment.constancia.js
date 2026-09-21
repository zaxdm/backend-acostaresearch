'use strict';

const path = require('node:path');
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
 *
 * Las «Condiciones de tu compra» resumen los Términos y Condiciones de la web
 * (acostaresearch-frontend/src/app/features/terminos). Si cambian allí, se
 * cambian aquí: la constancia no puede prometer algo distinto que los términos.
 */

const EMISOR = 'Acosta | IA & Research';
const RESPONSABLE = 'Benicio Gonzalo Acosta Enríquez · Trujillo, Perú';
const ZONA = 'America/Lima';
const LOGO = path.join(__dirname, 'assets', 'logo-ar.png');

const MEDIOS = {
  PAYPAL: 'PayPal',
  CULQI: 'Tarjeta o Yape (Culqi)',
  YAPE: 'Yape',
  PLIN: 'Plin',
  TRANSFERENCIA: 'Transferencia bancaria',
  WESTERN_UNION: 'Western Union',
};

/** Pasarelas cuyo identificador de cobro sirve al cliente para reclamar. */
const PASARELAS = new Set(['PAYPAL', 'CULQI']);

const COLOR = {
  texto: '#1a2233',
  suave: '#5b6272',
  tenue: '#8b95a6',
  linea: '#e2e5ea',
  fondo: '#f4f6fa',
  marca: '#1a56db',
  marcaOscura: '#172554',
  exito: '#177a45',
  exitoFondo: '#e3f5ea',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Lo que trae el plan, debajo de su nombre. */
function detalleDelPlan(plan) {
  const detalles = [];
  if (plan.words > 0) detalles.push(`${new Intl.NumberFormat('es-PE').format(plan.words)} palabras`);
  if (plan.durationDays > 0) detalles.push(`acceso por ${plan.durationDays} días`);
  return detalles.join(' · ') || null;
}

function nombreDelCliente(user) {
  const nombre = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
  return nombre || user?.email || 'Cliente';
}

/**
 * El número que el cliente puede cotejar con su banco o su app: el de Yape o
 * Plin que escribió, o el cobro de la pasarela. Un identificador interno
 * nuestro (un UUID) no le sirve de nada y se omite.
 */
function referenciaDeOperacion(payment) {
  const candidatos = [
    payment.operationCode,
    PASARELAS.has(payment.provider) ? payment.providerCaptureId : null,
  ];
  return candidatos.find((valor) => valor && !UUID.test(valor)) ?? null;
}

/** Resumen de los Términos y Condiciones que aplican a esta compra. */
function condiciones(payment) {
  const web = sitio();
  const lista = [];

  if (payment.plan?.kind === 'LICENSE') {
    lista.push(
      'Licencia personal, intransferible y no exclusiva, para tu propio trabajo académico. ' +
        'No se permite compartir la dirección del conector ni usarlo para trabajos de terceros ' +
        'o con fines comerciales.',
    );
  }
  lista.push(
    'La vigencia es la que indica el plan y se cuenta desde que se activa el acceso. ' +
      'Puedes ver la tuya en tu perfil.',
  );
  lista.push(
    'Es contenido digital: una vez activado el acceso no hay devolución. Sí se devuelve si el ' +
      'acceso no llegó a activarse, si se cobró dos veces o un importe distinto del anunciado, o ' +
      'si una falla atribuible a nosotros impide usarlo y no se resuelve en un plazo razonable.',
  );
  lista.push(
    'Para cualquier reclamo o devolución, escríbenos con tu correo y el número de esta ' +
      `constancia, o usa el Libro de Reclamaciones en ${web}/libro-de-reclamaciones.`,
  );
  lista.push(`Términos y Condiciones completos: ${web}/terminos.`);

  return lista;
}

function sitio() {
  return env.APP_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * Los datos que lleva la constancia, ya en texto. Separado del dibujo para
 * poder probarlo sin abrir el PDF.
 */
function datosDeConstancia(payment) {
  const descuento = payment.discountCents ?? 0;
  return {
    numero: numeroDeConstancia(payment),
    fechaDePago: fechaLarga(payment.paidAt),
    cliente: nombreDelCliente(payment.user),
    correo: payment.user?.email ?? payment.payerEmail ?? null,
    plan: payment.plan.name,
    detalle: detalleDelPlan(payment.plan),
    medio: MEDIOS[payment.provider] ?? payment.provider,
    referencia: referenciaDeOperacion(payment),
    subtotal: importe(payment.amountCents + descuento, payment.currency),
    descuento:
      descuento > 0
        ? `- ${importe(descuento, payment.currency)}${
            payment.discountCode?.code ? ` (código ${payment.discountCode.code})` : ''
          }`
        : null,
    total: importe(payment.amountCents, payment.currency),
    condiciones: condiciones(payment),
  };
}

/** Dibuja la constancia y devuelve el PDF como Buffer. */
function generarConstancia(payment) {
  const datos = datosDeConstancia(payment);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
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

    const ANCHO_PAGINA = doc.page.width;
    const M = 50; // margen lateral
    const ANCHO = ANCHO_PAGINA - M * 2;
    const DERECHA = M + ANCHO;

    // ── Franja superior ────────────────────────────────────────────────────
    doc.rect(0, 0, ANCHO_PAGINA, 6).fill(COLOR.marca);

    // ── Cabecera: marca a la izquierda, título y número a la derecha ──────
    const yCabecera = 38;
    try {
      doc.image(LOGO, M, yCabecera, { width: 44 });
    } catch {
      // Sin logo la constancia sigue siendo válida: solo se pierde el adorno.
    }
    doc
      .font('Helvetica-Bold')
      .fontSize(16)
      .fillColor(COLOR.texto)
      .text('Acosta', M + 54, yCabecera + 6, { continued: true })
      .fillColor(COLOR.marca)
      .text(' | IA & Research');
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(COLOR.suave)
      .text(`${sitio()}  ·  ${RESPONSABLE}`, M + 54, yCabecera + 27);

    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(COLOR.tenue)
      .text('CONSTANCIA DE PAGO', M, yCabecera + 2, { width: ANCHO, align: 'right', characterSpacing: 1 });
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(COLOR.texto)
      .text(datos.numero, M, yCabecera + 16, { width: ANCHO, align: 'right' });

    // Sello «PAGADO»
    const sello = 'PAGADO';
    doc.font('Helvetica-Bold').fontSize(8.5);
    const anchoSello = doc.widthOfString(sello, { characterSpacing: 1 }) + 18;
    const xSello = DERECHA - anchoSello;
    doc.roundedRect(xSello, yCabecera + 34, anchoSello, 17, 8.5).fill(COLOR.exitoFondo);
    doc
      .fillColor(COLOR.exito)
      .text(sello, xSello, yCabecera + 39, { width: anchoSello, align: 'center', characterSpacing: 1 });

    let y = 118;
    doc.moveTo(M, y).lineTo(DERECHA, y).lineWidth(1).strokeColor(COLOR.linea).stroke();

    // ── Dos columnas: cliente y pago ──────────────────────────────────────
    y += 20;
    const COLUMNA = (ANCHO - 30) / 2;
    const bloque = (x, titulo, filas) => {
      let yy = y;
      doc
        .font('Helvetica-Bold')
        .fontSize(8)
        .fillColor(COLOR.tenue)
        .text(titulo, x, yy, { characterSpacing: 1 });
      yy += 16;
      for (const [etiqueta, valor, fuerte] of filas) {
        if (!valor) continue;
        doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.tenue).text(etiqueta, x, yy);
        yy += 11;
        doc
          .font(fuerte ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(10.5)
          .fillColor(COLOR.texto)
          .text(valor, x, yy, { width: COLUMNA });
        yy = doc.y + 8;
      }
      return yy;
    };

    const finCliente = bloque(M, 'CLIENTE', [
      ['Nombre', datos.cliente, true],
      ['Correo', datos.correo],
    ]);
    const finPago = bloque(M + COLUMNA + 30, 'PAGO', [
      ['Fecha de pago', datos.fechaDePago],
      ['Medio de pago', datos.medio],
      ['N.º de operación', datos.referencia],
    ]);
    y = Math.max(finCliente, finPago) + 12;

    // ── Detalle: tabla con el plan ────────────────────────────────────────
    const COL_IMPORTE = 110;
    doc.rect(M, y, ANCHO, 24).fill(COLOR.fondo);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.suave);
    doc.text('DESCRIPCIÓN', M + 12, y + 8, { characterSpacing: 1 });
    doc.text('IMPORTE', DERECHA - COL_IMPORTE - 12, y + 8, {
      width: COL_IMPORTE,
      align: 'right',
      characterSpacing: 1,
    });
    y += 34;

    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(COLOR.texto)
      .text(datos.plan, M + 12, y, { width: ANCHO - COL_IMPORTE - 36 });
    const finNombre = doc.y;
    doc.text(datos.subtotal, DERECHA - COL_IMPORTE - 12, y, { width: COL_IMPORTE, align: 'right' });
    y = finNombre + 3;
    if (datos.detalle) {
      doc.font('Helvetica').fontSize(9).fillColor(COLOR.suave).text(datos.detalle, M + 12, y);
      y = doc.y;
    }
    y += 14;
    doc.moveTo(M, y).lineTo(DERECHA, y).lineWidth(1).strokeColor(COLOR.linea).stroke();

    // ── Totales, alineados a la derecha ───────────────────────────────────
    y += 12;
    const ANCHO_TOTALES = 250;
    const xTotales = DERECHA - ANCHO_TOTALES;
    const lineaTotal = (etiqueta, valor) => {
      doc.font('Helvetica').fontSize(9.5).fillColor(COLOR.suave).text(etiqueta, xTotales, y);
      doc.fillColor(COLOR.texto).text(valor, xTotales, y, { width: ANCHO_TOTALES - 12, align: 'right' });
      y += 18;
    };
    lineaTotal('Subtotal', datos.subtotal);
    if (datos.descuento) lineaTotal('Descuento', datos.descuento);

    y += 4;
    doc.roundedRect(xTotales - 12, y, ANCHO_TOTALES + 12, 34, 6).fill(COLOR.marcaOscura);
    doc
      .font('Helvetica-Bold')
      .fontSize(10.5)
      .fillColor('#ffffff')
      .text('Total pagado', xTotales, y + 12);
    doc
      .fontSize(13)
      .text(datos.total, xTotales, y + 10, { width: ANCHO_TOTALES - 12, align: 'right' });
    y += 58;

    // ── Condiciones de la compra ──────────────────────────────────────────
    doc
      .font('Helvetica-Bold')
      .fontSize(10.5)
      .fillColor(COLOR.texto)
      .text('Condiciones de tu compra', M, y);
    y = doc.y + 8;
    for (const condicion of datos.condiciones) {
      doc.circle(M + 3, y + 4.5, 1.6).fill(COLOR.marca);
      doc
        .font('Helvetica')
        .fontSize(8.8)
        .fillColor(COLOR.suave)
        .text(condicion, M + 14, y, { width: ANCHO - 14, lineGap: 1.5 });
      y = doc.y + 6;
    }

    // ── Pie ───────────────────────────────────────────────────────────────
    const yPie = doc.page.height - 78;
    doc.moveTo(M, yPie).lineTo(DERECHA, yPie).lineWidth(1).strokeColor(COLOR.linea).stroke();
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLOR.tenue)
      .text(
        'Este documento acredita que el pago fue recibido y confirmado. Es una constancia interna ' +
          'y no reemplaza a una boleta ni a una factura electrónica emitida ante SUNAT.',
        M,
        yPie + 12,
        { width: ANCHO, align: 'center', lineGap: 1.5 },
      );
    const whatsapp = env.SUPPORT_WHATSAPP_URL?.replace(/^https?:\/\//, '');
    const contacto = [sitio(), whatsapp ? `WhatsApp: ${whatsapp}` : null, env.MAIL_REPLY_TO]
      .filter(Boolean)
      .join('  ·  ');
    doc.text(contacto, M, doc.y + 4, { width: ANCHO, align: 'center' });

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

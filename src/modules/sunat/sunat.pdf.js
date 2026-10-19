'use strict';

/**
 * Representación impresa de la boleta y de la nota de crédito, en PDF.
 *
 * Se genera al vuelo desde la fila de `comprobantes` (nada se guarda). Lleva lo
 * que pide SUNAT: emisor con RUC y domicilio fiscal, serie y número, fecha,
 * cliente, detalle, valor de venta, IGV, total y monto en letras, y el código
 * QR con `RUC|tipo|serie|número|IGV|total|fecha|tipo doc|número doc|resumen|`.
 *
 * El estilo es el de la constancia de pago (`payments/payment.constancia.js`).
 */

const path = require('node:path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const env = require('../../config/env');
const { TIPO_COMPROBANTE, TIPO_DOCUMENTO } = require('./sunat.catalogos');
const { decimal } = require('./sunat.boleta');
const { montoEnLetras } = require('./sunat.letras');

const ZONA = 'America/Lima';
const LOGO = path.join(__dirname, '..', 'payments', 'assets', 'logo-ar.png');

const COLOR = {
  texto: '#1a2233',
  suave: '#5b6272',
  tenue: '#8b95a6',
  linea: '#e2e5ea',
  fondo: '#f4f6fa',
  marca: '#1a56db',
  marcaOscura: '#172554',
  alerta: '#b42318',
  alertaFondo: '#fde8e7',
};

const NOMBRE_DOCUMENTO = {
  [TIPO_DOCUMENTO.VARIOS]: 'Sin documento',
  [TIPO_DOCUMENTO.NO_DOMICILIADO]: 'No domiciliado',
  [TIPO_DOCUMENTO.DNI]: 'DNI',
  [TIPO_DOCUMENTO.CARNE_EXTRANJERIA]: 'Carné de extranjería',
  [TIPO_DOCUMENTO.RUC]: 'RUC',
  [TIPO_DOCUMENTO.PASAPORTE]: 'Pasaporte',
};

const paises = new Intl.DisplayNames(['es'], { type: 'region' });

function esNota(c) {
  return c.tipo === TIPO_COMPROBANTE.NOTA_CREDITO;
}

function soles(cents) {
  return `S/ ${new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)}`;
}

function fechaLarga(fecha) {
  return new Intl.DateTimeFormat('es-PE', { timeZone: ZONA, dateStyle: 'long', timeStyle: 'short' }).format(new Date(fecha));
}

function fechaIso(fecha) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(fecha),
  );
}

/** La boleta que anula una nota (`ANULA:B001-1` → `B001-1`). */
function boletaAnulada(c) {
  return esNota(c) ? c.origenClave.replace(/^ANULA:/, '') : null;
}

/** El motivo que va dentro del XML de la nota. */
function motivoDeLaNota(c) {
  const motivo = /<cac:DiscrepancyResponse>[\s\S]*?<cbc:Description>([\s\S]*?)<\/cbc:Description>/.exec(c.xmlFirmado ?? '');
  return motivo ? motivo[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : null;
}

/** La nota que anuló esta boleta, si la hay (`…|ANULADA:BC01-1`). */
function anuladaPor(c) {
  return /\|ANULADA:(\S+)$/.exec(c.origenClave)?.[1] ?? null;
}

/** El texto del QR, como lo pide SUNAT. */
function textoDelQr(c) {
  return [
    env.SUNAT_RUC ?? '',
    c.tipo,
    c.serie,
    c.numero,
    decimal(c.igvCents),
    decimal(c.totalCents),
    fechaIso(c.fechaEmision),
    c.clienteTipoDoc,
    c.clienteNumDoc,
    c.hash ?? '',
  ].join('|') + '|';
}

/** Los datos ya en texto, separados del dibujo para poder probarlos. */
function datosDelPdf(c) {
  const titulo = esNota(c) ? 'NOTA DE CRÉDITO ELECTRÓNICA' : 'BOLETA DE VENTA ELECTRÓNICA';
  const pais = c.clientePais ? (paises.of(c.clientePais) ?? c.clientePais) : null;
  return {
    titulo,
    numero: `${c.serie}-${c.numero}`,
    fecha: fechaLarga(c.fechaEmision),
    cliente: c.clienteNombre,
    documento: [NOMBRE_DOCUMENTO[c.clienteTipoDoc] ?? c.clienteTipoDoc, c.clienteNumDoc !== '-' ? c.clienteNumDoc : null]
      .filter(Boolean)
      .join(' '),
    pais,
    lineas: (c.items ?? []).map((i) => ({
      cantidad: i.cantidad,
      descripcion: i.descripcion,
      unitario: soles(i.precioUnitario),
      importe: soles(i.precioUnitario * i.cantidad),
    })),
    valor: soles(c.valorCents),
    igv: soles(c.igvCents),
    total: soles(c.totalCents),
    letras: montoEnLetras(c.totalCents, 'PEN'),
    pagadoEnDolares:
      c.monedaOriginal === 'USD'
        ? `Cobrado US$ ${decimal(c.importeOriginalCents)} al tipo de cambio ${Number(c.tipoCambio).toFixed(3)} (venta, SUNAT).`
        : null,
    anula: boletaAnulada(c),
    motivo: esNota(c) ? motivoDeLaNota(c) : null,
    anuladaPor: esNota(c) ? null : anuladaPor(c),
    hash: c.hash,
    qr: textoDelQr(c),
    pie: `Representación impresa de la ${esNota(c) ? 'Nota de Crédito' : 'Boleta de Venta'} Electrónica. ` +
      'Consulte su validez en www.sunat.gob.pe.',
  };
}

/** Dibuja el comprobante y devuelve el PDF como Buffer. */
async function generarPdf(c) {
  const datos = datosDelPdf(c);
  const qr = await QRCode.toBuffer(datos.qr, { errorCorrectionLevel: 'Q', margin: 1, width: 240 });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      info: { Title: `${datos.titulo} ${datos.numero}`, Author: env.SUNAT_RAZON_SOCIAL, Subject: datos.titulo },
    });
    const partes = [];
    doc.on('data', (parte) => partes.push(parte));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);

    const ANCHO_PAGINA = doc.page.width;
    const M = 50;
    const ANCHO = ANCHO_PAGINA - M * 2;
    const DERECHA = M + ANCHO;

    doc.rect(0, 0, ANCHO_PAGINA, 6).fill(COLOR.marca);

    // ── Cabecera: emisor a la izquierda, recuadro del comprobante a la derecha
    const yCab = 36;
    const ANCHO_CAJA = 190;
    const xCaja = DERECHA - ANCHO_CAJA;
    try {
      doc.image(LOGO, M, yCab, { width: 40 });
    } catch {
      // Sin logo el comprobante vale igual.
    }
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor(COLOR.texto)
      .text(env.SUNAT_NOMBRE_COMERCIAL, M + 50, yCab + 2, { width: xCaja - M - 60 });
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(COLOR.suave)
      .text(env.SUNAT_RAZON_SOCIAL, M + 50, doc.y + 2, { width: xCaja - M - 60 })
      .text(env.SUNAT_DOMICILIO, { width: xCaja - M - 60 });

    doc.roundedRect(xCaja, yCab - 4, ANCHO_CAJA, 70, 6).lineWidth(1.2).strokeColor(COLOR.marcaOscura).stroke();
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(COLOR.marcaOscura)
      .text(`RUC ${env.SUNAT_RUC ?? ''}`, xCaja, yCab + 6, { width: ANCHO_CAJA, align: 'center' })
      .fontSize(9)
      .text(datos.titulo, xCaja, yCab + 22, { width: ANCHO_CAJA, align: 'center' })
      .fontSize(13)
      .text(datos.numero, xCaja, yCab + 40, { width: ANCHO_CAJA, align: 'center' });

    let y = Math.max(doc.y, yCab + 80) + 14;
    doc.moveTo(M, y).lineTo(DERECHA, y).lineWidth(1).strokeColor(COLOR.linea).stroke();

    if (datos.anuladaPor) {
      y += 12;
      doc.roundedRect(M, y, ANCHO, 24, 6).fill(COLOR.alertaFondo);
      doc
        .font('Helvetica-Bold')
        .fontSize(9.5)
        .fillColor(COLOR.alerta)
        .text(`ANULADA con la nota de crédito ${datos.anuladaPor}`, M, y + 8, { width: ANCHO, align: 'center' });
      y += 24;
    }

    // ── Datos del cliente y de la emisión ─────────────────────────────────
    y += 16;
    const fila = (etiqueta, valor) => {
      if (!valor) return;
      doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.tenue).text(etiqueta, M, y, { width: 120 });
      doc.font('Helvetica').fontSize(10).fillColor(COLOR.texto).text(valor, M + 125, y - 1, { width: ANCHO - 125 });
      y = doc.y + 6;
    };
    fila('Fecha de emisión', datos.fecha);
    fila('Cliente', datos.cliente);
    fila('Documento', datos.documento);
    fila('País', datos.pais);
    fila('Moneda', 'Soles (PEN)');
    if (datos.anula) {
      fila('Documento que modifica', `Boleta de venta electrónica ${datos.anula}`);
      fila('Motivo', `01 - Anulación de la operación${datos.motivo ? `: ${datos.motivo}` : ''}`);
    }

    // ── Detalle ────────────────────────────────────────────────────────────
    y += 10;
    const C_CANT = 45;
    const C_UNIT = 90;
    const C_IMP = 90;
    const xUnit = DERECHA - C_IMP - C_UNIT;
    const xImp = DERECHA - C_IMP;
    doc.rect(M, y, ANCHO, 22).fill(COLOR.fondo);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.suave);
    doc.text('CANT.', M + 8, y + 7, { width: C_CANT - 8 });
    doc.text('DESCRIPCIÓN', M + C_CANT, y + 7);
    doc.text('P. UNITARIO', xUnit, y + 7, { width: C_UNIT - 8, align: 'right' });
    doc.text('IMPORTE', xImp, y + 7, { width: C_IMP - 8, align: 'right' });
    y += 30;
    for (const linea of datos.lineas) {
      doc.font('Helvetica').fontSize(9.5).fillColor(COLOR.texto);
      doc.text(String(linea.cantidad), M + 8, y, { width: C_CANT - 8 });
      doc.text(linea.descripcion, M + C_CANT, y, { width: xUnit - M - C_CANT - 10 });
      const fin = doc.y;
      doc.text(linea.unitario, xUnit, y, { width: C_UNIT - 8, align: 'right' });
      doc.text(linea.importe, xImp, y, { width: C_IMP - 8, align: 'right' });
      y = fin + 8;
    }
    doc.moveTo(M, y).lineTo(DERECHA, y).lineWidth(1).strokeColor(COLOR.linea).stroke();

    // ── Totales ────────────────────────────────────────────────────────────
    y += 12;
    const ANCHO_TOT = 230;
    const xTot = DERECHA - ANCHO_TOT;
    const total = (etiqueta, valor) => {
      doc.font('Helvetica').fontSize(9.5).fillColor(COLOR.suave).text(etiqueta, xTot, y);
      doc.fillColor(COLOR.texto).text(valor, xTot, y, { width: ANCHO_TOT - 8, align: 'right' });
      y += 17;
    };
    total('Op. gravada', datos.valor);
    total('IGV (18 %)', datos.igv);
    y += 2;
    doc.roundedRect(xTot - 10, y, ANCHO_TOT + 10, 30, 6).fill(COLOR.marcaOscura);
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#ffffff').text('Importe total', xTot, y + 10);
    doc.fontSize(12).text(datos.total, xTot, y + 9, { width: ANCHO_TOT - 8, align: 'right' });
    y += 42;

    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.texto).text(datos.letras, M, y, { width: ANCHO });
    y = doc.y + 4;
    if (datos.pagadoEnDolares) {
      doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.suave).text(datos.pagadoEnDolares, M, y, { width: ANCHO });
      y = doc.y + 4;
    }

    // ── QR y resumen ───────────────────────────────────────────────────────
    y += 16;
    const LADO_QR = 92;
    doc.image(qr, M, y, { width: LADO_QR });
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(COLOR.suave)
      .text(datos.pie, M + LADO_QR + 16, y + 18, { width: ANCHO - LADO_QR - 16, lineGap: 1.5 });
    if (datos.hash) {
      doc
        .fontSize(8)
        .fillColor(COLOR.tenue)
        .text(`Resumen (hash): ${datos.hash}`, M + LADO_QR + 16, doc.y + 6, { width: ANCHO - LADO_QR - 16 });
    }

    doc.end();
  });
}

/** `boleta-B001-6.pdf` o `nota-de-credito-BC01-1.pdf`. */
function nombreDelPdf(c) {
  return `${esNota(c) ? 'nota-de-credito' : 'boleta'}-${c.serie}-${c.numero}.pdf`;
}

module.exports = { generarPdf, datosDelPdf, textoDelQr, nombreDelPdf };

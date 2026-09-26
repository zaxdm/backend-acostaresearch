'use strict';

const path = require('node:path');
const PDFDocument = require('pdfkit');
const env = require('../../config/env');
const { nombreDelMes } = require('./ventas.datos');

/**
 * Reporte de ventas de un mes, en PDF apaisado.
 *
 * Es un documento INTERNO para el contador: lista cada venta y los totales.
 * No es un comprobante ni una declaración ante SUNAT, y lo dice en el pie.
 * Sigue el estilo de la constancia de pago (`payments/payment.constancia.js`).
 */

const EMISOR = 'Acosta | IA & Research';
const RESPONSABLE = 'Benicio Gonzalo Acosta Enríquez · Trujillo, Perú';
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
  exito: '#177a45',
  exitoFondo: '#e3f5ea',
  aviso: '#9a5b00',
  avisoFondo: '#fdf1dc',
};

function importe(cents, moneda = 'PEN') {
  const simbolo = moneda === 'USD' ? 'US$' : moneda === 'PEN' ? 'S/' : moneda;
  const cifra = new Intl.NumberFormat('es-PE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
  return `${simbolo} ${cifra}`;
}

function fechaCorta(iso) {
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: ZONA,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function fechaLarga(fecha) {
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: ZONA,
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(new Date(fecha));
}

function sitio() {
  return env.APP_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** Nombre del archivo al descargarlo: `ventas-2026-09.pdf`. */
function nombreDeArchivo({ anio, mes }, borrador = false) {
  return `ventas-${anio}-${String(mes).padStart(2, '0')}${borrador ? '-borrador' : ''}.pdf`;
}

/** Columnas de la tabla. `ancho` en puntos; suman el ancho útil apaisado. */
const COLUMNAS = [
  { clave: 'n', titulo: 'N.º', ancho: 28, alinear: 'right' },
  { clave: 'fecha', titulo: 'FECHA', ancho: 62 },
  { clave: 'cliente', titulo: 'CLIENTE', ancho: 170 },
  { clave: 'producto', titulo: 'PRODUCTO', ancho: 150 },
  { clave: 'via', titulo: 'VÍA', ancho: 105 },
  { clave: 'referencia', titulo: 'N.º OPERACIÓN', ancho: 95 },
  { clave: 'importe', titulo: 'IMPORTE', ancho: 76, alinear: 'right' },
  { clave: 'soles', titulo: 'EN SOLES', ancho: 56, alinear: 'right' },
];

/**
 * Dibuja el reporte y devuelve el PDF como Buffer.
 *
 * @param {object} p
 * @param {{anio:number, mes:number}} p.periodo
 * @param {object[]} p.ventas       filas de `ventas.datos.ventasDelMes`
 * @param {object}   p.resumen      `ventas.datos.resumir`
 * @param {number}   p.solesPorDolar
 * @param {Date}     p.generado     cuándo se cerró (o se generó el borrador)
 * @param {boolean}  p.borrador     mes en curso: puede cambiar todavía
 */
function generarReporte({ periodo, ventas, resumen, solesPorDolar, generado, borrador }) {
  const titulo = `Reporte de ventas · ${nombreDelMes(periodo)}`;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      info: { Title: titulo, Author: EMISOR, Subject: 'Reporte de ventas mensual' },
    });

    const partes = [];
    doc.on('data', (parte) => partes.push(parte));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);

    const ANCHO_PAGINA = doc.page.width;
    const ALTO_PAGINA = doc.page.height;
    const M = 40;
    const ANCHO = ANCHO_PAGINA - M * 2;
    const DERECHA = M + ANCHO;
    const LIMITE = ALTO_PAGINA - 70; // por debajo va el pie

    const pie = () => {
      const yPie = ALTO_PAGINA - 48;
      doc.moveTo(M, yPie).lineTo(DERECHA, yPie).lineWidth(1).strokeColor(COLOR.linea).stroke();
      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(COLOR.tenue)
        .text(
          'Reporte interno de ventas. No es un comprobante ni reemplaza a boletas o facturas ' +
            'electrónicas emitidas ante SUNAT. Los importes en dólares se pasan a soles al tipo de ' +
            `referencia ${solesPorDolar.toFixed(2)}, no al tipo oficial del día.`,
          M,
          yPie + 8,
          { width: ANCHO, align: 'center', lineBreak: true },
        );
    };

    // ── Cabecera (solo en la primera página) ──────────────────────────────
    doc.rect(0, 0, ANCHO_PAGINA, 6).fill(COLOR.marca);
    const yCabecera = 28;
    try {
      doc.image(LOGO, M, yCabecera, { width: 40 });
    } catch {
      // Sin logo el reporte sigue valiendo.
    }
    doc
      .font('Helvetica-Bold')
      .fontSize(15)
      .fillColor(COLOR.texto)
      .text('Acosta', M + 50, yCabecera + 5, { continued: true })
      .fillColor(COLOR.marca)
      .text(' | IA & Research');
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLOR.suave)
      .text(`${sitio()}  ·  ${RESPONSABLE}`, M + 50, yCabecera + 25);

    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(COLOR.tenue)
      .text('REPORTE DE VENTAS', M, yCabecera, { width: ANCHO, align: 'right', characterSpacing: 1 });
    const mesTitulo = nombreDelMes(periodo);
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor(COLOR.texto)
      .text(mesTitulo.charAt(0).toUpperCase() + mesTitulo.slice(1), M, yCabecera + 13, {
        width: ANCHO,
        align: 'right',
      });

    const sello = borrador ? 'BORRADOR · MES EN CURSO' : 'MES CERRADO';
    doc.font('Helvetica-Bold').fontSize(8);
    const anchoSello = doc.widthOfString(sello, { characterSpacing: 1 }) + 18;
    const xSello = DERECHA - anchoSello;
    doc
      .roundedRect(xSello, yCabecera + 34, anchoSello, 16, 8)
      .fill(borrador ? COLOR.avisoFondo : COLOR.exitoFondo);
    doc
      .fillColor(borrador ? COLOR.aviso : COLOR.exito)
      .text(sello, xSello, yCabecera + 38.5, { width: anchoSello, align: 'center', characterSpacing: 1 });

    let y = 92;
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(COLOR.suave)
      .text(
        `${borrador ? 'Generado' : 'Cerrado'} el ${fechaLarga(generado)} (hora de Lima).` +
          (borrador ? ' Puede cambiar hasta que termine el mes.' : ''),
        M,
        y,
      );
    y += 20;

    // ── Tarjetas de resumen ───────────────────────────────────────────────
    const monedas = Object.entries(resumen.totalesPorMoneda);
    const tarjetas = [
      ['VENTAS', String(resumen.ventas)],
      ...monedas.map(([moneda, cents]) => [
        moneda === 'USD' ? 'COBRADO EN DÓLARES' : 'COBRADO EN SOLES',
        importe(cents, moneda),
      ]),
      ['TOTAL EN SOLES', importe(resumen.totalSolesCents)],
    ];
    const hueco = 10;
    const anchoTarjeta = (ANCHO - hueco * (tarjetas.length - 1)) / tarjetas.length;
    tarjetas.forEach(([etiqueta, valor], i) => {
      const x = M + i * (anchoTarjeta + hueco);
      const ultima = i === tarjetas.length - 1;
      doc.roundedRect(x, y, anchoTarjeta, 44, 6).fill(ultima ? COLOR.marcaOscura : COLOR.fondo);
      doc
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .fillColor(ultima ? '#c7d2fe' : COLOR.tenue)
        .text(etiqueta, x + 12, y + 9, { characterSpacing: 0.8 });
      doc
        .font('Helvetica-Bold')
        .fontSize(13)
        .fillColor(ultima ? '#ffffff' : COLOR.texto)
        .text(valor, x + 12, y + 22);
    });
    y += 60;

    // ── Tabla de ventas ───────────────────────────────────────────────────
    const cabeceraTabla = () => {
      doc.rect(M, y, ANCHO, 20).fill(COLOR.fondo);
      doc.font('Helvetica-Bold').fontSize(7).fillColor(COLOR.suave);
      let x = M;
      for (const col of COLUMNAS) {
        doc.text(col.titulo, x + 4, y + 7, {
          width: col.ancho - 8,
          align: col.alinear ?? 'left',
          characterSpacing: 0.5,
        });
        x += col.ancho;
      }
      y += 24;
    };

    if (ventas.length === 0) {
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor(COLOR.suave)
        .text('No hubo ventas este mes.', M, y + 10, { width: ANCHO, align: 'center' });
      y += 40;
    } else {
      cabeceraTabla();
      ventas.forEach((venta, i) => {
        const celdas = {
          n: String(i + 1),
          fecha: fechaCorta(venta.fecha),
          cliente: [venta.cliente, venta.correo].filter(Boolean).join('\n') || '—',
          producto: venta.producto,
          via: venta.via,
          referencia: venta.referencia ?? '—',
          importe: importe(venta.importeCents, venta.moneda),
          soles: importe(venta.solesCents).replace('S/ ', ''),
        };

        doc.font('Helvetica').fontSize(7.5);
        const alto =
          Math.max(
            ...COLUMNAS.map((col) =>
              doc.heightOfString(celdas[col.clave], { width: col.ancho - 8 }),
            ),
          ) + 8;

        if (y + alto > LIMITE) {
          pie();
          doc.addPage({ size: 'A4', layout: 'landscape', margins: { top: 0, bottom: 0, left: 0, right: 0 } });
          y = 30;
          cabeceraTabla();
        }

        let x = M;
        for (const col of COLUMNAS) {
          doc
            .font(col.clave === 'importe' ? 'Helvetica-Bold' : 'Helvetica')
            .fontSize(7.5)
            .fillColor(col.clave === 'n' ? COLOR.tenue : COLOR.texto)
            .text(celdas[col.clave], x + 4, y + 3, {
              width: col.ancho - 8,
              align: col.alinear ?? 'left',
            });
          x += col.ancho;
        }
        y += alto;
        doc.moveTo(M, y - 2).lineTo(DERECHA, y - 2).lineWidth(0.5).strokeColor(COLOR.linea).stroke();
      });
      y += 12;
    }

    // ── Por vía de cobro ──────────────────────────────────────────────────
    const vias = Object.entries(resumen.porVia).sort((a, b) => b[1] - a[1]);
    if (vias.length > 0) {
      if (y + 30 + vias.length * 16 > LIMITE) {
        pie();
        doc.addPage({ size: 'A4', layout: 'landscape', margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        y = 30;
      }
      doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOR.texto).text('Por vía de cobro', M, y);
      y = doc.y + 6;
      const ANCHO_RESUMEN = 320;
      for (const [via, cents] of vias) {
        doc.font('Helvetica').fontSize(9).fillColor(COLOR.suave).text(via, M, y);
        doc
          .fillColor(COLOR.texto)
          .text(importe(cents), M, y, { width: ANCHO_RESUMEN, align: 'right' });
        y += 16;
      }
    }

    pie();
    doc.end();
  });
}

module.exports = { generarReporte, nombreDeArchivo };

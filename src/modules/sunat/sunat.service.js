'use strict';

/**
 * Emisión automática de boletas (fase 2, 19-oct-2026).
 *
 * Una pasada cada pocos minutos (`server.js`) hace dos cosas:
 *
 *  1. Reenvía las boletas que siguen PENDIENTE (SUNAT caído, sin respuesta).
 *     Se reenvía el MISMO XML con el mismo número: nunca se renumera.
 *  2. Busca las ventas cobradas desde `SUNAT_EMITIR_DESDE` que aún no tienen
 *     boleta, les da número, la firma, la guarda y la envía.
 *
 * Va aparte del cobro a propósito: si SUNAT falla, el cliente recibe igual lo
 * que compró y la boleta se reintenta en la pasada siguiente. Solo LEE las
 * ventas; nunca cambia un pago.
 *
 * Avisos, solo al programador (no es tema de administración): boleta
 * rechazada, boleta para revisar, venta que no puede llevar boleta, y boleta
 * que lleva varios intentos sin llegar a SUNAT.
 */

const fs = require('node:fs');
const env = require('../../config/env');
const logger = require('../../config/logger');
const { avisarAlProgramador } = require('../../lib/notify');
const ventasRepository = require('../ventas/ventas.repository');
const sunatRepository = require('./sunat.repository');
const tipoCambio = require('./sunat.tipoCambio');
const { construirBoleta, nombreDelArchivo, fechaLima } = require('./sunat.boleta');
const { construirNotaCredito } = require('./sunat.notaCredito');
const { leerCertificado, firmar, resumenDeLaFirma } = require('./sunat.firma');
const { enviarComprobante, ESTADO } = require('./sunat.envio');
const { TIPO_COMPROBANTE, TIPO_OPERACION } = require('./sunat.catalogos');
const { ventasParaBoleta, datosDeBoleta, nombreDelPais } = require('./sunat.ventas');
const { sendMail } = require('../../lib/mailer');
const { AppError, NotFoundError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');
const pdf = require('./sunat.pdf');
const correos = require('./sunat.correo');

/** La clave de la nota que anula una boleta: `ANULA:B001-1`. */
const claveDeAnulacion = (serie, numero) => `ANULA:${serie}-${numero}`;

/** Una venta se factura pasados unos minutos, para que un carrito termine de cobrarse entero. */
const MARGEN_MS = 3 * 60 * 1000;
/** Boletas por pasada, nuevas y reenvíos por separado. */
const POR_PASADA = 20;
/** Intentos sin llegar a SUNAT tras los que se avisa (y se sigue intentando). */
const AVISAR_TRAS_INTENTOS = 6;
/**
 * Pausa entre dos envíos seguidos. La beta contestó «401» a todo envío hecho
 * justo después de otro (19-oct-2026); con 3 s pasaron todos.
 */
const PAUSA_ENTRE_ENVIOS_MS = 3000;

/**
 * @param {object} dep  todo lo de fuera, para poder probarlo sin base ni SUNAT
 */
function crearEmisor(dep) {
  const { repo, ventas, cambio, config, enviar, cargarCertificado, avisar, log } = dep;
  const pausa = dep.pausa ?? PAUSA_ENTRE_ENVIOS_MS;
  let certificado = null;
  let ultimoEnvio = 0;
  let corriendo = false;
  /** Ventas que no pueden llevar boleta y ya se avisaron (para no repetirlo cada pasada). */
  const avisadas = new Set();

  const credenciales = () => ({ ruc: config.ruc, usuario: config.usuario, clave: config.clave });

  async function enviarYGuardar(fila) {
    const nombre = nombreDelArchivo(config.ruc, fila.serie, fila.numero, fila.tipo);
    const espera = ultimoEnvio + pausa - Date.now();
    if (espera > 0) await new Promise((listo) => setTimeout(listo, espera));
    ultimoEnvio = Date.now();
    const r = await enviar({ nombre, xmlFirmado: fila.xmlFirmado, credenciales: credenciales(), ambiente: config.ambiente });
    const intentos = fila.intentos + 1;
    const base = { intentos, codigoSunat: r.codigo ?? null, mensaje: r.descripcion ?? null };
    const numero = `${fila.serie}-${fila.numero}`;

    if (r.estado === ESTADO.ACEPTADO || r.estado === ESTADO.OBSERVADO) {
      await repo.actualizar(fila.id, {
        ...base,
        estado: r.estado === ESTADO.ACEPTADO ? 'ACEPTADO' : 'OBSERVADO',
        observaciones: r.observaciones?.length ? r.observaciones : undefined,
        cdrZip: r.cdrZip ?? undefined,
        enviadoEn: new Date(),
      });
      if (fila.tipo === TIPO_COMPROBANTE.NOTA_CREDITO) {
        // La boleta queda anulada y su venta, libre: si sigue siendo una venta,
        // la pasada siguiente le hace una boleta nueva con los datos de hoy.
        const [serie, num] = fila.origenClave.replace(/^ANULA:/, '').split('-');
        await repo.liberarVenta(serie, Number(num), numero);
        log.info({ numero, anula: `${serie}-${num}` }, 'Nota de crédito aceptada por SUNAT');
      } else {
        log.info({ numero, estado: r.estado, codigo: r.codigo }, 'Boleta aceptada por SUNAT');
      }
      return r.estado;
    }

    if (r.estado === ESTADO.RECHAZADO) {
      await repo.actualizar(fila.id, { ...base, estado: 'RECHAZADO', cdrZip: r.cdrZip ?? undefined, enviadoEn: new Date() });
      avisar({
        titulo: `SUNAT rechazó ${fila.tipo === TIPO_COMPROBANTE.NOTA_CREDITO ? 'la nota' : 'la boleta'} ${numero}`,
        mensaje: `${r.codigo ?? ''} ${r.descripcion ?? ''}`.trim(),
        etiquetas: ['warning'],
      });
      return r.estado;
    }

    if (r.yaPresentado) {
      // Puede que el primer envío sí llegara y se perdiera la respuesta. Lo
      // decide una persona mirando en SOL; reenviar no lo arregla.
      await repo.actualizar(fila.id, { ...base, estado: 'REVISAR' });
      avisar({
        titulo: `Boleta ${numero} para revisar`,
        mensaje: `SUNAT dice que ya fue presentada (${r.codigo}). Consúltala en SOL.`,
        etiquetas: ['warning'],
      });
      return 'REVISAR';
    }

    // Excepción o sin respuesta: sigue pendiente y se reintenta.
    await repo.actualizar(fila.id, base);
    if (intentos === AVISAR_TRAS_INTENTOS) {
      avisar({
        titulo: `La boleta ${numero} no llega a SUNAT`,
        mensaje: `${intentos} intentos. Último: ${r.descripcion ?? r.estado}`,
        etiquetas: ['warning'],
      });
    }
    return r.estado;
  }

  async function emitir(venta, ahora) {
    const dia = fechaLima(venta.fecha).dia;
    const datos = datosDeBoleta(venta, cambio.para(dia));
    certificado ??= cargarCertificado();

    let fila;
    try {
      fila = await repo.crearConNumero(config.serie, (numero) => {
        const boleta = construirBoleta({
          emisor: { ruc: config.ruc, razonSocial: config.razonSocial, nombreComercial: config.nombreComercial },
          serie: config.serie,
          numero,
          fecha: ahora,
          moneda: datos.moneda,
          tipoOperacion: TIPO_OPERACION.VENTA_INTERNA,
          cliente: datos.cliente,
          items: datos.items,
        });
        const xmlFirmado = firmar(boleta.xml, certificado);
        return {
          tipo: TIPO_COMPROBANTE.BOLETA,
          serie: config.serie,
          numero,
          origenClave: venta.origenClave,
          fechaEmision: ahora,
          clienteTipoDoc: datos.cliente.tipoDocumento,
          clienteNumDoc: datos.cliente.numeroDocumento,
          clienteNombre: datos.cliente.nombre.slice(0, 200),
          clientePais: datos.clientePais,
          moneda: datos.moneda,
          totalCents: boleta.totales.total,
          valorCents: boleta.totales.valor,
          igvCents: boleta.totales.igv,
          monedaOriginal: datos.monedaOriginal,
          importeOriginalCents: datos.importeOriginalCents,
          tipoCambio: datos.tipoCambio,
          items: datos.items,
          hash: resumenDeLaFirma(xmlFirmado),
          xmlFirmado,
        };
      });
    } catch (error) {
      // Otra pasada ya le dio boleta a esta venta.
      if (error?.code === 'P2002') return null;
      throw error;
    }
    return enviarYGuardar(fila);
  }

  /**
   * Anula una boleta aceptada con una nota de crédito (motivo 01) y la envía.
   * Si la venta sigue siendo una venta (pago cobrado, código no anulado), al
   * liberarse se volverá a facturar: eso solo se hace con `refacturar`, para
   * que nadie vuelva a emitir sin querer lo que quería anular.
   */
  async function anular({ serie, numero, motivo, refacturar = false }) {
    const boleta = await repo.buscar(serie, numero);
    if (!boleta || boleta.tipo !== TIPO_COMPROBANTE.BOLETA) throw new Error(`No hay boleta ${serie}-${numero}.`);
    if (boleta.estado !== 'ACEPTADO' && boleta.estado !== 'OBSERVADO') {
      throw new Error(`La boleta ${serie}-${numero} está ${boleta.estado}: solo se anula una aceptada.`);
    }
    if (boleta.origenClave.includes('|ANULADA')) throw new Error(`La boleta ${serie}-${numero} ya está anulada.`);
    const clave = claveDeAnulacion(serie, numero);
    if ((await repo.clavesConBoleta([clave])).has(clave)) {
      throw new Error(`La boleta ${serie}-${numero} ya tiene una nota de crédito (puede estar pendiente de envío).`);
    }
    if (!refacturar && (await repo.sigueSiendoVenta(boleta.origenClave))) {
      throw new Error(
        `${boleta.origenClave} sigue siendo una venta: al anular se le hará una boleta nueva. ` +
          'Si eso es lo que quieres, repite con --refacturar; si no era una venta, anúlala o recházala primero.',
      );
    }

    certificado ??= cargarCertificado();
    const ahora = new Date();
    const cliente = {
      tipoDocumento: boleta.clienteTipoDoc,
      numeroDocumento: boleta.clienteNumDoc,
      nombre: boleta.clienteNombre,
      pais: boleta.clientePais ? nombreDelPais(boleta.clientePais) : null,
    };
    const fila = await repo.crearConNumero(config.serieNotas, (num) => {
      const nota = construirNotaCredito({
        emisor: { ruc: config.ruc, razonSocial: config.razonSocial, nombreComercial: config.nombreComercial },
        serie: config.serieNotas,
        numero: num,
        fecha: ahora,
        moneda: boleta.moneda,
        referencia: { serie, numero },
        motivo,
        cliente,
        items: boleta.items,
      });
      const xmlFirmado = firmar(nota.xml, certificado);
      return {
        tipo: TIPO_COMPROBANTE.NOTA_CREDITO,
        serie: config.serieNotas,
        numero: num,
        origenClave: clave,
        fechaEmision: ahora,
        clienteTipoDoc: boleta.clienteTipoDoc,
        clienteNumDoc: boleta.clienteNumDoc,
        clienteNombre: boleta.clienteNombre,
        clientePais: boleta.clientePais,
        moneda: boleta.moneda,
        totalCents: nota.totales.total,
        valorCents: nota.totales.valor,
        igvCents: nota.totales.igv,
        monedaOriginal: boleta.monedaOriginal,
        importeOriginalCents: boleta.importeOriginalCents,
        tipoCambio: boleta.tipoCambio,
        items: boleta.items,
        mensaje: motivo,
        hash: resumenDeLaFirma(xmlFirmado),
        xmlFirmado,
      };
    });
    const estado = await enviarYGuardar(fila);
    return { nota: `${fila.serie}-${fila.numero}`, estado };
  }

  /**
   * El correo al cliente con el PDF de cada comprobante aceptado. Una boleta ya
   * anulada no se envía, ni la nota de una boleta que nunca se envió: el
   * cliente no tiene por qué enterarse de un error que no vio. Si el envío
   * falla, queda pendiente para la pasada siguiente.
   *
   * `correoDe` resuelve uno y devuelve su estado. `forzar` (el «Reenviar» del
   * panel) lo manda aunque ya se hubiera enviado o no aplicara.
   */
  async function correoDe(fila, { forzar = false } = {}) {
    const { enviarCorreo } = dep;
    const numero = `${fila.serie}-${fila.numero}`;
    const esNota = fila.tipo === TIPO_COMPROBANTE.NOTA_CREDITO;
    const anula = esNota ? fila.origenClave.replace(/^ANULA:/, '') : null;

    let clave = fila.origenClave;
    let noAplica = !esNota && clave.includes('|ANULADA');
    if (config.correosDesde && fila.fechaEmision < config.correosDesde) noAplica = true;
    if (esNota) {
      const [serie, num] = anula.split('-');
      const boleta = await repo.buscar(serie, Number(num));
      noAplica = noAplica || boleta?.correo !== 'ENVIADO';
      clave = boleta?.origenClave ?? clave;
    }
    if (noAplica && !forzar) {
      await repo.actualizar(fila.id, { correo: 'NO_APLICA' });
      return 'NO_APLICA';
    }

    const para = await repo.destinatario(clave);
    if (!para) {
      await repo.actualizar(fila.id, { correo: 'SIN_DESTINATARIO' });
      return 'SIN_DESTINATARIO';
    }
    const mensaje = esNota
      ? correos.notaEmitida({ nombre: para.nombre, numero, anula, motivo: pdf.datosDelPdf(fila).motivo })
      : correos.boletaEmitida({
          nombre: para.nombre,
          numero,
          productos: (fila.items ?? []).map((i) => i.descripcion).join(', '),
          total: fila.totalCents,
        });
    const adjunto = { filename: pdf.nombreDelPdf(fila), content: await pdf.generarPdf(fila), contentType: 'application/pdf' };
    await enviarCorreo({ to: para.email, ...mensaje, attachments: [adjunto] });
    await repo.actualizar(fila.id, { correo: 'ENVIADO', correoEnviadoEn: new Date() });
    return 'ENVIADO';
  }

  async function enviarCorreos() {
    if (!dep.enviarCorreo) return 0;
    let enviados = 0;
    for (const fila of await repo.correosPendientes(POR_PASADA)) {
      try {
        if ((await correoDe(fila)) === 'ENVIADO') enviados += 1;
      } catch (error) {
        // Queda pendiente: la pasada siguiente lo vuelve a intentar.
        log.error({ err: error, numero: `${fila.serie}-${fila.numero}` }, 'No se pudo enviar el comprobante al cliente');
      }
    }
    return enviados;
  }

  async function pasada(ahora = new Date()) {
    if (!config.activo || corriendo) return null;
    corriendo = true;
    const resumen = { reenviadas: 0, emitidas: 0, sinBoleta: 0 };
    try {
      for (const fila of await repo.pendientes(POR_PASADA)) {
        await enviarYGuardar(fila);
        resumen.reenviadas += 1;
      }

      await cambio.actualizar();
      const hasta = new Date(ahora.getTime() - MARGEN_MS);
      const todas = await ventas(config.desde, hasta);
      const conBoleta = await repo.clavesConBoleta(todas.map((v) => v.origenClave));
      const nuevas = todas.filter((v) => !conBoleta.has(v.origenClave));

      for (const venta of nuevas) {
        if (resumen.emitidas >= POR_PASADA) break;
        try {
          if ((await emitir(venta, new Date())) !== null) resumen.emitidas += 1;
        } catch (error) {
          resumen.sinBoleta += 1;
          if (!avisadas.has(venta.origenClave)) {
            avisadas.add(venta.origenClave);
            log.error({ err: error, origen: venta.origenClave }, 'Venta sin boleta');
            avisar({
              titulo: 'Una venta se quedó sin boleta',
              mensaje: `${venta.origenClave}: ${error.message}`,
              etiquetas: ['warning'],
            });
          }
        }
      }
      resumen.correos = await enviarCorreos();
      return resumen;
    } finally {
      corriendo = false;
    }
  }

  return { pasada, emitir, enviarYGuardar, anular, enviarCorreos, correoDe };
}

/** Las ventas entre dos fechas, ya agrupadas para facturar. */
async function ventasEntre(desde, hasta) {
  const [pagos, codigos] = await Promise.all([
    sunatRepository.pagosCobrados(desde, hasta),
    sunatRepository.codigosVendidos(desde, hasta),
  ]);
  const [idsDeCodigos, nombresDeProducto] = await Promise.all([
    ventasRepository.codigosEntre(pagos.map((p) => p.providerOrderId).filter(Boolean)),
    ventasRepository.nombresDeProducto([
      ...new Set(codigos.map((c) => c.license?.productCode ?? c.productCode)),
    ]),
  ]);
  return ventasParaBoleta({ pagos, codigos, idsDeCodigos, nombresDeProducto });
}

const emisor = crearEmisor({
  repo: sunatRepository,
  ventas: ventasEntre,
  cambio: tipoCambio,
  enviar: enviarComprobante,
  cargarCertificado: () =>
    leerCertificado({ pfx: fs.readFileSync(env.SUNAT_PFX), clave: env.SUNAT_PFX_CLAVE }),
  avisar: avisarAlProgramador,
  enviarCorreo: sendMail,
  log: logger,
  config: {
    activo: env.SUNAT_ACTIVO,
    ambiente: env.SUNAT_AMBIENTE,
    desde: env.SUNAT_EMITIR_DESDE ? new Date(env.SUNAT_EMITIR_DESDE) : null,
    ruc: env.SUNAT_RUC,
    razonSocial: env.SUNAT_RAZON_SOCIAL,
    nombreComercial: env.SUNAT_NOMBRE_COMERCIAL,
    serie: env.SUNAT_SERIE,
    serieNotas: env.SUNAT_SERIE_NOTAS,
    correosDesde: env.SUNAT_CORREOS_DESDE ? new Date(env.SUNAT_CORREOS_DESDE) : null,
    usuario: env.SUNAT_USUARIO,
    clave: env.SUNAT_CLAVE,
  },
});

/** `B001-1` → `['B001', 1]`. */
function partir(numero) {
  const [serie, num] = numero.split('-');
  return [serie, Number(num)];
}

/** Lo que pide la web: el PDF del cliente y el panel del administrador. */
const consultas = {
  misBoletas: (userId) => sunatRepository.boletasDeUsuario(userId),

  /** El PDF de un comprobante: del dueño de la venta, o de un ADMIN. Null si no le toca. */
  async pdfDe({ id, userId, esAdmin }) {
    const fila = await sunatRepository.buscarPorId(id);
    if (!fila) return null;
    if (!esAdmin) {
      // La nota se mira por la boleta que anula. Un ajeno recibe lo mismo que «no existe».
      const clave =
        fila.tipo === TIPO_COMPROBANTE.NOTA_CREDITO
          ? (await sunatRepository.buscar(...partir(fila.origenClave.replace(/^ANULA:/, ''))))?.origenClave
          : fila.origenClave;
      if (!clave || (await sunatRepository.duenoDe(clave)) !== userId) return null;
    }
    return { nombre: pdf.nombreDelPdf(fila), contenido: await pdf.generarPdf(fila) };
  },

  listar: () => sunatRepository.listar(),

  /**
   * Las boletas y notas de una venta, para su ficha en Accesos, con el correo
   * al que se mandan. `canal`: `codigo` o `pago` (Yape, pasarela…).
   */
  async deVenta(canal, id) {
    const claves = await sunatRepository.clavesDeVenta(canal, id);
    const comprobantes = await sunatRepository.deClaves(claves);
    const para = claves.length ? await sunatRepository.destinatario(claves[0]) : null;
    return { comprobantes, correoDestinatario: para?.email ?? null };
  },

  /** El XML firmado o la CDR, para el panel. */
  async archivo(id, cual) {
    const fila = await sunatRepository.buscarPorId(id);
    if (!fila) return null;
    const base = nombreDelArchivo(env.SUNAT_RUC ?? '', fila.serie, fila.numero, fila.tipo);
    if (cual === 'xml') {
      return { nombre: `${base}.xml`, tipo: 'application/xml', contenido: Buffer.from(fila.xmlFirmado, 'utf8') };
    }
    if (!fila.cdrZip) return null;
    return { nombre: `R-${base}.zip`, tipo: 'application/zip', contenido: Buffer.from(fila.cdrZip) };
  },

  /**
   * El «Anular» del panel: lo mismo que `scripts/sunat-anular.js`. Lo que el
   * emisor rechaza (ya anulada, sigue siendo venta…) vuelve como 409 con su
   * mensaje, que el panel enseña tal cual.
   */
  async anularPorId({ id, motivo, refacturar }) {
    const fila = await sunatRepository.buscarPorId(id);
    if (!fila) throw new NotFoundError('No encontramos ese comprobante.');
    try {
      return await emisor.anular({ serie: fila.serie, numero: fila.numero, motivo, refacturar });
    } catch (error) {
      throw new AppError(error.message, { statusCode: 409, code: ERROR_CODES.VALIDATION_ERROR });
    }
  },

  async reenviarCorreo(id) {
    const fila = await sunatRepository.buscarPorId(id);
    if (!fila) return null;
    return emisor.correoDe(fila, { forzar: true });
  },
};

module.exports = {
  ...consultas,
  pasada: (ahora) => emisor.pasada(ahora),
  anular: (datos) => emisor.anular(datos),
  crearEmisor,
  MARGEN_MS,
  AVISAR_TRAS_INTENTOS,
};

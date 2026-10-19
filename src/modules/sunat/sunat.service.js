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
const { leerCertificado, firmar, resumenDeLaFirma } = require('./sunat.firma');
const { enviarComprobante, ESTADO } = require('./sunat.envio');
const { TIPO_COMPROBANTE, TIPO_OPERACION } = require('./sunat.catalogos');
const { ventasParaBoleta, datosDeBoleta } = require('./sunat.ventas');

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
    const nombre = nombreDelArchivo(config.ruc, fila.serie, fila.numero);
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
      log.info({ numero, estado: r.estado, codigo: r.codigo }, 'Boleta aceptada por SUNAT');
      return r.estado;
    }

    if (r.estado === ESTADO.RECHAZADO) {
      await repo.actualizar(fila.id, { ...base, estado: 'RECHAZADO', cdrZip: r.cdrZip ?? undefined, enviadoEn: new Date() });
      avisar({
        titulo: `SUNAT rechazó la boleta ${numero}`,
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
      return resumen;
    } finally {
      corriendo = false;
    }
  }

  return { pasada, emitir, enviarYGuardar };
}

/** Las ventas entre dos fechas, ya agrupadas para facturar. */
async function ventasEntre(desde, hasta) {
  const [pagos, codigos] = await Promise.all([
    sunatRepository.pagosCobrados(desde, hasta),
    sunatRepository.codigosVendidos(desde, hasta),
  ]);
  const [idsDeCodigos, nombresDeProducto] = await Promise.all([
    ventasRepository.codigosEntre(pagos.map((p) => p.providerOrderId).filter(Boolean)),
    ventasRepository.nombresDeProducto([...new Set(codigos.map((c) => c.productCode))]),
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
  log: logger,
  config: {
    activo: env.SUNAT_ACTIVO,
    ambiente: env.SUNAT_AMBIENTE,
    desde: env.SUNAT_EMITIR_DESDE ? new Date(env.SUNAT_EMITIR_DESDE) : null,
    ruc: env.SUNAT_RUC,
    razonSocial: env.SUNAT_RAZON_SOCIAL,
    nombreComercial: env.SUNAT_NOMBRE_COMERCIAL,
    serie: env.SUNAT_SERIE,
    usuario: env.SUNAT_USUARIO,
    clave: env.SUNAT_CLAVE,
  },
});

module.exports = { pasada: (ahora) => emisor.pasada(ahora), crearEmisor, MARGEN_MS, AVISAR_TRAS_INTENTOS };

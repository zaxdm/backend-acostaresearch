'use strict';

/**
 * De las ventas cobradas a los datos de cada boleta, sin base de datos de por
 * medio (así se prueba sin MySQL).
 *
 * Qué es una venta es la misma regla de los cierres mensuales
 * (`modules/ventas/ventas.datos.js`): un pago cobrado con importe, o un código
 * vendido a mano; el pago que nace al canjear un código no cuenta, porque esa
 * venta ya está en su código. Además:
 *
 *  - Un carrito entero es UNA boleta, con una línea por producto.
 *  - Todo se emite gravado con IGV 18 % dentro del precio (afectación 10):
 *    lo confirmó el contador el 19-oct-2026. Los precios no cambian.
 *  - La boleta va siempre en soles. Lo cobrado en dólares se pasa con el tipo
 *    de cambio (venta) de SUNAT, que queda guardado en la boleta.
 *  - Cliente: un extranjero va como «no domiciliado» con su nombre y país; los
 *    demás, como «varios» con su nombre si se sabe. Sin documento hay un tope
 *    de S/700 por boleta: por encima, la venta se queda sin boleta y se avisa.
 */

const { TIPO_DOCUMENTO } = require('./sunat.catalogos');

/** Afectación de IGV de todas las líneas: gravado. */
const AFECTACION_VENTAS = '10';

/** Por encima de este total (en céntimos de sol) la boleta exige el documento del cliente. */
const TOPE_SIN_DOCUMENTO_CENTS = 70000;

const paises = new Intl.DisplayNames(['es'], { type: 'region' });

function nombreDelPais(iso) {
  try {
    return paises.of(iso)?.toUpperCase() ?? iso;
  } catch {
    return iso;
  }
}

function nombreDe(user) {
  const nombre = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
  return nombre || null;
}

function clienteDe(user) {
  const nombre = nombreDe(user);
  const pais = user?.pais ? String(user.pais).toUpperCase() : null;
  if (pais && pais !== 'PE') {
    return { tipoDocumento: TIPO_DOCUMENTO.NO_DOMICILIADO, numeroDocumento: '-', nombre: nombre ?? 'CLIENTE DEL EXTRANJERO', pais };
  }
  return { tipoDocumento: TIPO_DOCUMENTO.VARIOS, numeroDocumento: '-', nombre: nombre ?? 'CLIENTES VARIOS', pais: null };
}

/**
 * Agrupa pagos y códigos en ventas a facturar, ordenadas por fecha.
 *
 * @param {object} p
 * @param {object[]} p.pagos   cobrados, con `plan` y `user`
 * @param {object[]} p.codigos vendidos a mano
 * @param {Set<string>} [p.idsDeCodigos]  códigos cuyo canje creó alguno de esos pagos
 * @param {Record<string,string>} [p.nombresDeProducto]
 */
function ventasParaBoleta({ pagos, codigos, idsDeCodigos = new Set(), nombresDeProducto = {} }) {
  const porClave = new Map();

  for (const pago of pagos) {
    if (idsDeCodigos.has(pago.providerOrderId)) continue;
    const clave = pago.cartId ? `CARRITO:${pago.cartId}` : `PAGO:${pago.id}`;
    const venta = porClave.get(clave) ?? {
      origenClave: clave,
      fecha: new Date(pago.paidAt),
      cliente: clienteDe(pago.user),
      items: [],
    };
    if (new Date(pago.paidAt) > venta.fecha) venta.fecha = new Date(pago.paidAt);
    venta.items.push({
      codigo: pago.plan?.productCode ?? pago.plan?.code ?? null,
      descripcion: pago.plan?.name ?? 'Servicio',
      importeCents: pago.amountCents,
      moneda: pago.currency,
    });
    porClave.set(clave, venta);
  }

  for (const codigo of codigos) {
    // Lo que tiene hoy, no lo que se vendió: un código movido de producto se
    // factura por el producto al que se movió.
    const producto = codigo.license?.productCode ?? codigo.productCode;
    porClave.set(`CODIGO:${codigo.id}`, {
      origenClave: `CODIGO:${codigo.id}`,
      fecha: new Date(codigo.createdAt),
      cliente: clienteDe(null),
      items: [
        {
          codigo: producto,
          descripcion: nombresDeProducto[producto] ?? producto,
          importeCents: codigo.amountCents,
          moneda: 'PEN',
        },
      ],
    });
  }

  return [...porClave.values()].sort((a, b) => a.fecha - b.fecha);
}

/**
 * Los datos de la boleta de una venta, ya en soles. Lanza con un mensaje
 * legible si la venta no puede llevar boleta tal cual (moneda desconocida,
 * carrito con dos monedas, más de S/700 sin documento).
 *
 * @param {object} venta  una de `ventasParaBoleta`
 * @param {number|null} tipoCambio  soles por dólar (venta), si hace falta
 */
function datosDeBoleta(venta, tipoCambio) {
  const monedas = [...new Set(venta.items.map((i) => i.moneda))];
  if (monedas.length > 1) throw new Error(`La venta mezcla monedas (${monedas.join(', ')}).`);
  const [monedaOriginal] = monedas;
  if (monedaOriginal !== 'PEN' && monedaOriginal !== 'USD') {
    throw new Error(`Moneda sin conversión a soles: ${monedaOriginal}.`);
  }
  if (monedaOriginal === 'USD' && !(tipoCambio > 0)) {
    throw new Error('Falta el tipo de cambio para pasar los dólares a soles.');
  }

  const aSoles = (cents) => (monedaOriginal === 'USD' ? Math.round(cents * tipoCambio) : cents);
  const items = venta.items.map((item) => ({
    codigo: item.codigo ?? undefined,
    descripcion: item.descripcion,
    cantidad: 1,
    precioUnitario: aSoles(item.importeCents),
    afectacion: AFECTACION_VENTAS,
  }));
  const totalCents = items.reduce((suma, i) => suma + i.precioUnitario, 0);

  if (venta.cliente.tipoDocumento === TIPO_DOCUMENTO.VARIOS && totalCents > TOPE_SIN_DOCUMENTO_CENTS) {
    throw new Error('Pasa de S/700 y no tenemos el DNI del cliente: la boleta lo exige.');
  }

  return {
    cliente: venta.cliente.pais
      ? { ...venta.cliente, pais: nombreDelPais(venta.cliente.pais) }
      : venta.cliente,
    clientePais: venta.cliente.pais,
    items,
    moneda: 'PEN',
    monedaOriginal,
    importeOriginalCents: venta.items.reduce((suma, i) => suma + i.importeCents, 0),
    tipoCambio: monedaOriginal === 'USD' ? tipoCambio : null,
  };
}

module.exports = { ventasParaBoleta, datosDeBoleta, AFECTACION_VENTAS, TOPE_SIN_DOCUMENTO_CENTS };

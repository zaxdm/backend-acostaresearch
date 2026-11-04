'use strict';

/**
 * El flujo de caja, sin base de datos de por medio.
 *
 * La caja se lleva por DÍA (hora de Lima): cada día abre con el saldo con que
 * cerró el anterior, suma lo que entró, resta lo que salió y cierra. El mes es
 * la suma de sus días.
 *
 * Empieza el día de su saldo inicial (`SALDO_INICIAL`, uno solo, opcional) y lo
 * anterior no cuenta. Sin saldo inicial empieza en 0 el día de la primera venta
 * (lo decide `caja.service`), para que se vea desde el primer momento.
 *
 * Nada se congela: si se corrige un gasto de hace dos semanas, todos los días
 * siguientes se recalculan solos.
 */

const { SOLES_POR_DOLAR } = require('../ventas/ventas.datos');

/** Perú: UTC−5 sin horario de verano. */
const DESFASE_LIMA_HORAS = 5;
const UN_DIA_MS = 24 * 3600 * 1000;

/** «2026-11-03»: el día de Lima de un instante. */
function diaDeLima(fecha) {
  return new Date(new Date(fecha).getTime() - DESFASE_LIMA_HORAS * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
}

/** «2026-11-03» de una columna DATE (Prisma la trae a medianoche UTC). */
function diaDeColumna(fecha) {
  return new Date(fecha).toISOString().slice(0, 10);
}

/** El primer instante de un día de Lima, como fecha UTC. */
function inicioDelDia(dia) {
  const [anio, mes, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(anio, mes - 1, d, DESFASE_LIMA_HORAS));
}

function diaSiguiente(dia) {
  return new Date(Date.parse(`${dia}T00:00:00Z`) + UN_DIA_MS).toISOString().slice(0, 10);
}

/** Primer y último día de un mes: `{ primero: '2026-11-01', ultimo: '2026-11-30' }`. */
function diasDelMes(anio, mes) {
  const dos = (n) => String(n).padStart(2, '0');
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return { primero: `${anio}-${dos(mes)}-01`, ultimo: `${anio}-${dos(mes)}-${dos(ultimo)}` };
}

function aSoles(cents, moneda) {
  return moneda === 'USD' ? Math.round(cents * SOLES_POR_DOLAR) : cents;
}

/** Una venta de la web (de `ventas.datos`) como entrada de caja. */
function entradaDeVenta(venta) {
  return {
    id: `${venta.origen === 'CODIGO' ? 'codigo' : 'pago'}:${venta.origenId}`,
    automatico: true,
    origen: 'VENTA',
    dia: diaDeLima(venta.fecha),
    hora: venta.fecha,
    tipo: 'ENTRADA',
    concepto: venta.producto,
    detalle: venta.cliente ?? venta.correo ?? null,
    categoria: 'Venta en la web',
    medio: venta.via,
    moneda: venta.moneda,
    montoCents: venta.importeCents,
    solesCents: venta.solesCents,
  };
}

/** Un servicio registrado en el panel (con boleta) como entrada de caja. */
function entradaDeServicio(servicio) {
  return {
    id: `servicio:${servicio.id}`,
    automatico: true,
    origen: 'SERVICIO',
    dia: diaDeLima(servicio.pagadoEn),
    hora: new Date(servicio.pagadoEn).toISOString(),
    tipo: 'ENTRADA',
    concepto: servicio.concepto,
    detalle: servicio.clienteNombre ?? null,
    categoria: 'Servicio con boleta',
    medio: servicio.medio ?? null,
    moneda: servicio.moneda,
    montoCents: servicio.importeCents,
    solesCents: aSoles(servicio.importeCents, servicio.moneda),
  };
}

/** Un movimiento apuntado a mano, tal como lo ve el panel. */
function movimientoManual(fila) {
  return {
    id: fila.id,
    automatico: false,
    origen: 'MANUAL',
    dia: diaDeColumna(fila.fecha),
    hora: null,
    /** Solo para ordenar dentro del día: cuándo se apuntó. */
    apuntado: fila.creadoEn ? new Date(fila.creadoEn).toISOString() : null,
    tipo: fila.tipo,
    concepto: fila.concepto,
    detalle: null,
    categoria: fila.categoria ?? null,
    medio: fila.medio ?? null,
    moneda: fila.moneda,
    montoCents: fila.montoCents,
    solesCents: fila.solesCents,
  };
}

function conSigno(movimiento) {
  return movimiento.tipo === 'SALIDA' ? -movimiento.solesCents : movimiento.solesCents;
}

/** Dentro del día, del más reciente al más antiguo (los manuales, por cuándo se apuntaron). */
function porHoraDesc(a, b) {
  return (b.hora ?? b.apuntado ?? '').localeCompare(a.hora ?? a.apuntado ?? '');
}

/**
 * La caja de un mes, día por día.
 *
 * - `inicio`: el movimiento SALDO_INICIAL ya normalizado, o null si la caja aún
 *   no empezó.
 * - `movimientos`: entradas y salidas (sin el saldo inicial) desde el día de
 *   inicio hasta el final del mes; lo de antes del inicio se ignora.
 * - `hoy`: el día de Lima de hoy. Los días futuros no se muestran.
 */
function armarCaja({ inicio, movimientos, anio, mes, hoy }) {
  const { primero, ultimo } = diasDelMes(anio, mes);
  const vacio = {
    anio,
    mes,
    hoy,
    inicio,
    aperturaCents: 0,
    entradasCents: 0,
    salidasCents: 0,
    cierreCents: 0,
    dias: [],
  };
  if (!inicio) return vacio;

  const desde = primero > inicio.dia ? primero : inicio.dia;
  const hasta = ultimo < hoy ? ultimo : hoy;
  const validos = movimientos.filter((m) => m.dia >= inicio.dia);

  // Lo que había al abrir el primer día que se muestra.
  let saldo = inicio.solesCents;
  for (const m of validos) if (m.dia < desde) saldo += conSigno(m);

  // Un mes anterior al inicio de la caja, o futuro: sin días.
  if (desde > hasta) {
    const antesDelInicio = ultimo < inicio.dia;
    const cifra = antesDelInicio ? 0 : saldo;
    return { ...vacio, aperturaCents: cifra, cierreCents: cifra };
  }

  const porDia = new Map();
  for (const m of validos) {
    if (m.dia < desde || m.dia > hasta) continue;
    if (!porDia.has(m.dia)) porDia.set(m.dia, []);
    porDia.get(m.dia).push(m);
  }

  const aperturaCents = saldo;
  let entradasCents = 0;
  let salidasCents = 0;
  const dias = [];

  for (let dia = desde; dia <= hasta; dia = diaSiguiente(dia)) {
    const delDia = (porDia.get(dia) ?? []).sort(porHoraDesc);
    const entradas = delDia.filter((m) => m.tipo === 'ENTRADA').reduce((s, m) => s + m.solesCents, 0);
    const salidas = delDia.filter((m) => m.tipo === 'SALIDA').reduce((s, m) => s + m.solesCents, 0);
    const apertura = saldo;
    // El día de inicio abre con el saldo inicial; lo apuntado ese día ya suma después.
    saldo = apertura + entradas - salidas;
    entradasCents += entradas;
    salidasCents += salidas;
    dias.push({
      dia,
      esInicio: dia === inicio.dia,
      aperturaCents: apertura,
      entradasCents: entradas,
      salidasCents: salidas,
      cierreCents: saldo,
      movimientos: delDia,
    });
  }

  return {
    ...vacio,
    aperturaCents,
    entradasCents,
    salidasCents,
    cierreCents: saldo,
    dias: dias.reverse(),
  };
}

module.exports = {
  diaDeLima,
  diaDeColumna,
  inicioDelDia,
  diaSiguiente,
  diasDelMes,
  aSoles,
  entradaDeVenta,
  entradaDeServicio,
  movimientoManual,
  armarCaja,
};

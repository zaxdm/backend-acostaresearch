'use strict';

/**
 * Declaración mensual del 621 (20-oct-2026): el cálculo y los avisos.
 *
 * Lo que se fija: ventas de boletas menos notas, crédito de las compras, saldo
 * a favor que pasa al mes siguiente, renta del 1.5 % sobre la base, las
 * casillas en soles enteros, un mes declarado que ya no cambia, y que cada
 * aviso sale una sola vez y solo para meses pendientes. Sin base: el
 * repositorio se reemplaza aquí.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const calc = require('../src/modules/tributos/tributos.calculo');
const repo = require('../src/modules/tributos/tributos.repository');
const notify = require('../src/lib/notify');
const mailer = require('../src/lib/mailer');

// S/159 con IGV dentro: base 134.75, IGV 24.25.
const BOLETA = { tipo: '03', valorCents: 13475, igvCents: 2425 };
const NOTA = { tipo: '07', valorCents: 13475, igvCents: 2425 };

test('ventas de boletas menos notas, crédito de compras y renta del 1.5 %', () => {
  const r = calc.calcularMes({
    comprobantes: [BOLETA, BOLETA, BOLETA, NOTA],
    compras: [{ baseCents: 10000, igvCents: 1800 }],
  });
  assert.equal(r.ventas.boletas, 3);
  assert.equal(r.ventas.notas, 1);
  assert.equal(r.ventas.baseCents, 26950);
  assert.equal(r.ventas.igvCents, 4850);
  assert.equal(r.compras.igvCents, 1800);
  assert.equal(r.igvAPagarCents, 3050);
  assert.equal(r.rentaCents, 404); // 1.5 % de 269.50
  assert.equal(r.totalAPagarCents, 3454);
  assert.deepEqual(
    r.casillas.filter((c) => c.casilla).map((c) => [c.casilla, c.soles]),
    [['100', 270], ['101', 49], ['107', 100], ['108', 18], ['301', 270]],
  );
});

test('si las compras superan las ventas no se paga IGV y queda saldo a favor', () => {
  const r = calc.calcularMes({
    comprobantes: [BOLETA],
    compras: [{ baseCents: 50000, igvCents: 9000 }],
    saldoAnteriorCents: 500,
  });
  assert.equal(r.igvAPagarCents, 0);
  assert.equal(r.saldoSiguienteCents, 9000 + 500 - 2425);
  assert.equal(r.rentaCents, 202);
});

test('el ajuste manual suma base e IGV del 18 %', () => {
  const r = calc.calcularMes({ comprobantes: [], compras: [], ajusteBaseCents: 100000 });
  assert.equal(r.ventas.igvCents, 18000);
  assert.equal(r.igvAPagarCents, 18000);
  assert.equal(r.rentaCents, 1500);
});

test('fechas: meses desde octubre de 2026 y días al vencimiento en hora de Lima', () => {
  assert.deepEqual(calc.mesesHasta({ anio: 2027, mes: 1 }), [
    { anio: 2026, mes: 10 },
    { anio: 2026, mes: 11 },
    { anio: 2026, mes: 12 },
    { anio: 2027, mes: 1 },
  ]);
  assert.deepEqual(calc.mesesHasta({ anio: 2026, mes: 9 }), []);
  // 23:30 de Lima del 12-nov ya es 13-nov en UTC: siguen faltando 6 días al 18.
  assert.equal(calc.diasHasta(new Date('2026-11-18T00:00:00Z'), new Date('2026-11-13T04:30:00Z')), 6);
  assert.equal(calc.diasHasta(new Date('2026-11-18T00:00:00Z'), new Date('2026-11-19T15:00:00Z')), -1);
});

// ── El servicio, con el repositorio en memoria ─────────────────────────────

function conRepo({ comprobantes = {}, compras = {}, filas = [] }) {
  const originales = { ...repo };
  const avisos = [];
  const correos = [];
  repo.comprobantesDelMes = async (p) => comprobantes[`${p.anio}-${p.mes}`] ?? [];
  repo.comprasDelMes = async (p) => compras[`${p.anio}-${p.mes}`] ?? [];
  repo.extranjerasPorPagar = async () => [];
  repo.declaraciones = async () => filas;
  repo.correoDelAdministrador = async () => 'admin@ejemplo.com';
  repo.declaracion = async (p) => filas.find((f) => f.anio === p.anio && f.mes === p.mes) ?? null;
  repo.guardar = async (p, data) => {
    let fila = filas.find((f) => f.anio === p.anio && f.mes === p.mes);
    if (!fila) {
      fila = { anio: p.anio, mes: p.mes, estado: 'PENDIENTE', ajusteBaseCents: 0 };
      filas.push(fila);
    }
    Object.assign(fila, data);
    return fila;
  };
  const avisarOriginal = notify.avisarAlAdmin;
  const programadorOriginal = notify.avisarAlProgramador;
  const enviarOriginal = mailer.sendMail;
  notify.avisarAlAdmin = (a) => avisos.push(a);
  // Ninguna prueba manda un aviso de verdad (ya pasó: caso 11b de /programar).
  notify.avisarAlProgramador = (a) => avisos.push({ ...a, programador: true });
  mailer.sendMail = async (m) => correos.push(m);
  // El servicio toma las funciones al cargarse: se carga de nuevo con las de prueba.
  delete require.cache[require.resolve('../src/modules/tributos/tributos.service')];
  const servicio = require('../src/modules/tributos/tributos.service');
  return {
    servicio,
    filas,
    avisos,
    correos,
    restaurar() {
      Object.assign(repo, originales);
      notify.avisarAlAdmin = avisarOriginal;
      notify.avisarAlProgramador = programadorOriginal;
      mailer.sendMail = enviarOriginal;
      delete require.cache[require.resolve('../src/modules/tributos/tributos.service')];
    },
  };
}

test('el saldo a favor pasa de un mes al siguiente; un mes declarado queda congelado', async () => {
  const ctx = conRepo({
    comprobantes: { '2026-10': [BOLETA], '2026-11': [BOLETA, BOLETA] },
    compras: { '2026-10': [{ baseCents: 50000, igvCents: 9000 }] },
  });
  try {
    const ahora = new Date('2026-11-20T15:00:00Z');
    const [nov, oct] = await ctx.servicio.meses(ahora);
    assert.equal(oct.calculo.saldoSiguienteCents, 9000 - 2425);
    assert.equal(nov.calculo.saldoAnteriorCents, 6575);
    assert.equal(nov.calculo.igvAPagarCents, 0); // 4850 − 6575
    assert.equal(nov.enCurso, true);

    await ctx.servicio.declarar({ anio: 2026, mes: 10 }, { numeroOrden: '123', igvPagadoCents: 0, rentaPagadaCents: 202 }, ahora);
    assert.equal(ctx.filas[0].estado, 'PAGADA');
    // Una compra más de octubre después de declarar no cambia lo declarado.
    const despues = conRepo({
      comprobantes: { '2026-10': [BOLETA], '2026-11': [BOLETA, BOLETA] },
      compras: { '2026-10': [{ baseCents: 50000, igvCents: 9000 }, { baseCents: 1000, igvCents: 180 }] },
      filas: ctx.filas,
    });
    try {
      const [, octDespues] = await despues.servicio.meses(ahora);
      assert.equal(octDespues.calculo.compras.igvCents, 9000);
    } finally {
      despues.restaurar();
    }
  } finally {
    ctx.restaurar();
  }
});

test('avisos: sin fecha, a 5 días y a 1 día, una vez cada uno; nada si ya se declaró', async () => {
  const ctx = conRepo({ comprobantes: { '2026-10': [BOLETA] } });
  try {
    // 3-nov: octubre ya terminó y no tiene fecha.
    assert.equal(await ctx.servicio.pasadaDeAvisos(new Date('2026-11-03T15:00:00Z')), 1);
    assert.match(ctx.avisos[0].titulo, /fecha de vencimiento/);
    assert.equal(await ctx.servicio.pasadaDeAvisos(new Date('2026-11-03T16:00:00Z')), 0);

    await ctx.servicio.actualizar({ anio: 2026, mes: 10 }, { vencimiento: '2026-11-18' }, new Date('2026-11-03T17:00:00Z'));
    assert.equal(await ctx.servicio.pasadaDeAvisos(new Date('2026-11-12T15:00:00Z')), 0); // faltan 6
    assert.equal(await ctx.servicio.pasadaDeAvisos(new Date('2026-11-13T15:00:00Z')), 1); // faltan 5
    assert.match(ctx.avisos[1].titulo, /Declara octubre 2026 antes del 18 de noviembre/);
    assert.match(ctx.avisos[1].mensaje, /IGV S\/ 24.25 \+ renta S\/ 2.02/);
    assert.match(ctx.correos[1].text, /\[100\] Ventas gravadas: base imponible: S\/ 135/);
    assert.equal(await ctx.servicio.pasadaDeAvisos(new Date('2026-11-14T15:00:00Z')), 0);
    assert.equal(await ctx.servicio.pasadaDeAvisos(new Date('2026-11-17T15:00:00Z')), 1); // último
    assert.equal(ctx.avisos[2].prioridad, 5);

    await ctx.servicio.declarar({ anio: 2026, mes: 10 }, {}, new Date('2026-11-17T16:00:00Z'));
    assert.equal(ctx.filas[0].estado, 'DECLARADA');
    // Se reabre y se cambia la fecha: los avisos vuelven a armarse.
    await ctx.servicio.reabrir({ anio: 2026, mes: 10 }, new Date('2026-11-17T17:00:00Z'));
    await ctx.servicio.actualizar({ anio: 2026, mes: 10 }, { vencimiento: '2026-11-20' }, new Date('2026-11-17T17:00:00Z'));
    assert.equal(await ctx.servicio.pasadaDeAvisos(new Date('2026-11-17T18:00:00Z')), 1);
  } finally {
    ctx.restaurar();
  }
});

test('no se cambia un mes ya declarado ni uno fuera de rango', async () => {
  const ctx = conRepo({ filas: [{ anio: 2026, mes: 10, estado: 'DECLARADA', calculo: calc.calcularMes({ comprobantes: [], compras: [] }) }] });
  try {
    const ahora = new Date('2026-11-05T15:00:00Z');
    await assert.rejects(ctx.servicio.actualizar({ anio: 2026, mes: 10 }, { vencimiento: '2026-11-18' }, ahora), /Reábrelo/);
    await assert.rejects(ctx.servicio.detalle({ anio: 2026, mes: 9 }, ahora), /no tiene declaración/);
    await assert.rejects(ctx.servicio.detalle({ anio: 2026, mes: 12 }, ahora), /no tiene declaración/);
  } finally {
    ctx.restaurar();
  }
});

// ── Compras del extranjero (21-oct-2026) ───────────────────────────────────

test('una compra del extranjero pasa a soles, lleva el 18 % y no entra dos veces', async () => {
  const ctx = conRepo({});
  const creadas = [];
  repo.crearCompra = async (data) => {
    if (creadas.some((c) => c.rucProveedor === data.rucProveedor && c.serie === data.serie && c.numero === data.numero)) {
      throw Object.assign(new Error('duplicada'), { code: 'P2002' });
    }
    creadas.push(data);
    return data;
  };
  try {
    const datos = {
      tipo: 'EXTRANJERO',
      fecha: '2026-10-21',
      razonSocial: 'Anthropic',
      documento: 'INV-2026-001',
      monedaOriginal: 'USD',
      importeOriginalCents: 2000,
      tipoCambio: 3.43,
    };
    const compra = await ctx.servicio.agregarCompra(datos, 'admin');
    assert.equal(compra.baseCents, 6860);
    assert.equal(compra.igvCents, 1235);
    assert.equal(compra.rucProveedor, '-');
    assert.equal(compra.serie, 'EXT');
    assert.equal(compra.igvPagadoEn, null);
    await assert.rejects(ctx.servicio.agregarCompra({ ...datos, documento: ' inv-2026-001' }, 'admin'), /ya está registrada/);
    await ctx.servicio.agregarCompra({ ...datos, documento: 'INV-2026-002' }, 'admin');
    assert.equal(creadas.length, 2);
  } finally {
    ctx.restaurar();
  }
});

test('el IGV del 1662 se anota en un mes pendiente y no en uno declarado', async () => {
  const ctx = conRepo({ filas: [{ anio: 2026, mes: 10, estado: 'DECLARADA', ajusteBaseCents: 0 }] });
  const compra = { id: 'c1', tipo: 'EXTRANJERO', igvCents: 1235 };
  let cambio = null;
  repo.buscarCompra = async (id) => (id === 'c1' ? compra : null);
  repo.actualizarCompra = async (_id, data) => (cambio = data);
  try {
    await assert.rejects(ctx.servicio.pagarIgvDeExtranjera('c1', { fecha: '2026-10-30', ordenPago: '1' }), /ya está declarado/);
    await ctx.servicio.pagarIgvDeExtranjera('c1', { fecha: '2026-11-12', ordenPago: '87654321' });
    assert.equal(cambio.ordenPago, '87654321');
    assert.equal(cambio.igvPagadoEn.toISOString().slice(0, 10), '2026-11-12');
    await assert.rejects(ctx.servicio.pagarIgvDeExtranjera('otra', { fecha: '2026-11-12' }), /no existe/);
  } finally {
    ctx.restaurar();
  }
});

// ── Cronograma de SUNAT (21-oct-2026) ──────────────────────────────────────

const cronograma = require('../src/modules/tributos/tributos.cronograma');

/** La configuración está congelada: se fija el RUC que recibe el cronograma. */
function conRuc(ruc, fn) {
  const { vencimientoDelCronograma, tieneElAnio } = cronograma;
  cronograma.vencimientoDelCronograma = (periodo, _ruc, tabla) => vencimientoDelCronograma(periodo, ruc, tabla);
  cronograma.tieneElAnio = (anio, _ruc, tabla) => tieneElAnio(anio, ruc, tabla);
  return Promise.resolve()
    .then(fn)
    .finally(() => Object.assign(cronograma, { vencimientoDelCronograma, tieneElAnio }));
}

test('el cronograma da el vencimiento por dígito del RUC; sin dígito cargado, nada', () => {
  assert.equal(cronograma.vencimientoDelCronograma({ anio: 2026, mes: 10 }, '10720995960').toISOString().slice(0, 10), '2026-11-16');
  assert.equal(cronograma.vencimientoDelCronograma({ anio: 2026, mes: 12 }, '10720995960').toISOString().slice(0, 10), '2027-01-18');
  assert.equal(cronograma.vencimientoDelCronograma({ anio: 2026, mes: 10 }, '10720995961'), null);
  assert.equal(cronograma.vencimientoDelCronograma({ anio: 2027, mes: 1 }, '10720995960'), null);
  // Las 12 del año, cada una en el mes siguiente a su periodo.
  for (let mes = 1; mes <= 12; mes += 1) {
    const vence = cronograma.vencimientoDelCronograma({ anio: 2026, mes }, '10720995960');
    assert.equal(vence.getUTCMonth(), mes % 12, `periodo ${mes}`);
  }
});

test('sin fecha escrita vale la del cronograma; la escrita a mano manda', () =>
  conRuc('10720995960', async () => {
    const ctx = conRepo({});
    try {
      const ahora = new Date('2026-11-05T15:00:00Z');
      let oct = await ctx.servicio.detalle({ anio: 2026, mes: 10 }, ahora);
      assert.equal(oct.vencimiento, '2026-11-16');
      assert.equal(oct.vencimientoOrigen, 'cronograma');
      assert.equal(oct.diasParaVencer, 11);

      await ctx.servicio.actualizar({ anio: 2026, mes: 10 }, { vencimiento: '2026-11-20' }, ahora);
      oct = await ctx.servicio.detalle({ anio: 2026, mes: 10 }, ahora);
      assert.equal(oct.vencimiento, '2026-11-20');
      assert.equal(oct.vencimientoOrigen, 'manual');
      assert.equal(oct.vencimientoCronograma, '2026-11-16');
    } finally {
      ctx.restaurar();
    }
  }));

test('los avisos usan la fecha del cronograma y no piden poner la fecha', () =>
  conRuc('10720995960', async () => {
    const ctx = conRepo({ comprobantes: { '2026-10': [BOLETA] } });
    try {
      // 11-nov: faltan 5 días para el 16.
      assert.equal(await ctx.servicio.pasadaDeAvisos(new Date('2026-11-11T15:00:00Z')), 1);
      assert.equal(ctx.avisos.length, 1);
      assert.ok(ctx.filas.find((f) => f.mes === 10).avisoPrevioEn);
      assert.equal(ctx.filas.find((f) => f.mes === 10).avisoSinFechaEn, undefined);
    } finally {
      ctx.restaurar();
    }
  }));

test('en diciembre, si falta el cronograma del año siguiente, avisa al programador una vez', () =>
  conRuc('10720995960', async () => {
    const ctx = conRepo({});
    try {
      const diciembre = new Date('2026-12-05T15:00:00Z');
      await ctx.servicio.pasadaDeAvisos(diciembre);
      await ctx.servicio.pasadaDeAvisos(new Date('2026-12-06T15:00:00Z'));
      const delCronograma = ctx.avisos.filter((a) => a.programador);
      assert.equal(delCronograma.length, 1);
      assert.match(delCronograma[0].titulo, /2027/);
      // En noviembre no se avisa nada de esto.
      const otro = conRepo({});
      try {
        await otro.servicio.pasadaDeAvisos(new Date('2026-11-05T15:00:00Z'));
        assert.equal(otro.avisos.filter((a) => a.programador).length, 0);
      } finally {
        otro.restaurar();
      }
    } finally {
      ctx.restaurar();
    }
  }));

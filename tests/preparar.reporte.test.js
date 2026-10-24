'use strict';

/**
 * El reporte de IA de Turnitin en «Humanizar» (`preparar.reporte`, 24-oct-2026):
 * se cruza con el Word, se rechaza si no es de ese documento, se consume, y el
 * humanizador rehace solo lo marcado.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const informe = require('../src/modules/preparar/preparar.reporte');
const reporteIa = require('../src/modules/projects/project.reporte-ia');
const humanizador = require('../src/modules/preparar/preparar.humanizar');
const cuerpo = require('../src/modules/preparar/preparar.cuerpo');

const LIMPIO =
  'La empresa importadora cuenta con un almacén central en Pucallpa donde trabajan cuarenta operarios en dos turnos diarios de recepción y despacho de mercancía.';
const MARCADO =
  'La información se organizará por trabajador y la población objetivo será el personal operativo que desempeñe funciones de recepción, ubicación y despacho durante el estudio.';
const OTRO =
  'Los niños de tres años de la institución privada escucharon cuentos tradicionales todas las semanas durante el año escolar con sus docentes de aula.';

const parrafo = (clave, texto) => ({ clave, id: Number(clave), texto, nivel: null, palabras: cuerpo.palabrasDe(texto), citas: null });

/** Un reporte como el que devuelve `reporteIa.leer`: las palabras y cuáles estaban marcadas. */
function reporteDe(tramos) {
  const palabras = [];
  const ia = [];
  for (const [texto, marcado] of tramos) {
    for (const p of texto.split(/\s+/)) {
      const limpia = reporteIa.normalizar(p);
      if (!limpia) continue;
      palabras.push(limpia);
      ia.push(marcado ? '1' : '0');
    }
  }
  return { palabras: palabras.join(' '), ia: ia.join('') };
}

function subir(userId, reporte) {
  const id = `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`;
  informe._subidos.set(id, { userId, vence: Date.now() + 60_000, reporte });
  return id;
}

test('marca los párrafos resaltados y deja fuera los limpios', () => {
  const reporte = reporteDe([[LIMPIO, false], [MARCADO, true]]);
  const marcados = informe.marcadosDe(reporte, [parrafo('1', LIMPIO), parrafo('2', MARCADO)]);
  assert.deepEqual([...marcados], ['2']);
});

test('el encargo con el reporte de su Word pasa y lo consume', () => {
  const id = subir('u1', reporteDe([[LIMPIO, false], [MARCADO, true]]));
  const hecho = informe.paraElEncargo({ userId: 'u1', reporteId: id, parrafos: [parrafo('1', LIMPIO), parrafo('2', MARCADO)] });
  assert.equal(hecho.marcados, 1);
  assert.throws(() => informe.paraElEncargo({ userId: 'u1', reporteId: id, parrafos: [parrafo('1', LIMPIO)] }), /ya no está/);
});

test('el reporte de otro usuario no sirve', () => {
  const id = subir('u1', reporteDe([[MARCADO, true]]));
  assert.throws(() => informe.paraElEncargo({ userId: 'u2', reporteId: id, parrafos: [parrafo('1', MARCADO)] }), /ya no está/);
});

test('un reporte de otro Word se rechaza', () => {
  const id = subir('u1', reporteDe([[OTRO, true]]));
  assert.throws(
    () => informe.paraElEncargo({ userId: 'u1', reporteId: id, parrafos: [parrafo('1', LIMPIO), parrafo('2', MARCADO)] }),
    /no es de este Word/,
  );
});

test('un reporte vencido no sirve', () => {
  const id = subir('u1', reporteDe([[MARCADO, true]]));
  assert.throws(
    () => informe.paraElEncargo({ userId: 'u1', reporteId: id, parrafos: [parrafo('1', MARCADO)] }, Date.now() + 2 * 60_000),
    /ya no está/,
  );
});

test('un PDF que no es PDF se rechaza con un mensaje para el cliente', async () => {
  await assert.rejects(informe.recibir({ userId: 'u1', buffer: Buffer.from('hola') }), /no es un PDF/);
});

test('con soloClaves, el humanizador solo manda los marcados', async () => {
  const mandados = [];
  const generar = async (peticion) => {
    const { parrafos } = JSON.parse(peticion.mensajes[0].texto);
    const salida = {};
    for (const [clave, texto] of Object.entries(parrafos)) {
      mandados.push(clave);
      salida[clave] = typeof texto === 'string' ? texto : texto.texto;
    }
    return { texto: JSON.stringify(salida), uso: { promptTokenCount: 1, candidatesTokenCount: 1 } };
  };
  await humanizador.humanizar({
    parrafos: [parrafo('1', LIMPIO), parrafo('2', MARCADO)],
    generar,
    modelos: ['falso'],
    conPasada: false,
    soloClaves: new Set(['2']),
  }).catch(() => null);
  assert.ok(mandados.length > 0);
  assert.ok(mandados.every((clave) => clave === '2'), mandados.join(','));
});

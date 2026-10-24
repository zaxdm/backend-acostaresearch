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

const motor = require('../src/modules/preparar/preparar.motor');

const ORIGINAL_MARCADO =
  'La evidencia acumulada, sin embargo, no fue tan uniforme como el entusiasmo. Savva y Pérez (2021) hallaron un efecto global pequeño a favor de los libros electrónicos, pero ninguna diferencia en la comprensión de historias. La realidad mostró, entonces, una escuela que adoptaba narraciones digitales y una literatura que todavía discutía en qué condiciones estas ayudaban a comprender.';

test('con reporte, un párrafo marcado y solo maquillado se rechaza por ser lo marcado', () => {
  const maquillado =
    'Pero la evidencia acumulada no fue tan uniforme como el entusiasmo. Savva y Pérez (2021) hallaron un efecto global pequeño a favor de los libros electrónicos, aunque sin diferencias en la comprensión de historias. La realidad mostró entonces una escuela que adoptaba narraciones digitales y una literatura que seguía discutiendo en qué condiciones ayudaban a comprender.';
  assert.match(motor.comprobarHumanizado(ORIGINAL_MARCADO, maquillado, { estricto: true }), /marcado por Turnitin/);
});

test('con reporte, fundir lo marcado en menos oraciones se rechaza', () => {
  const fundido =
    'Los resultados de la investigación salieron menos parejos que el entusiasmo inicial, ya que Savva y Pérez (2021) obtuvieron para el libro electrónico un efecto global pequeño a su favor y ninguna diferencia cuando se medía comprender historias, de modo que la escuela ya usaba relatos en pantalla mientras los estudios seguían sin acuerdo sobre cuándo servían.';
  assert.match(motor.comprobarHumanizado(ORIGINAL_MARCADO, fundido, { estricto: true }), /menos oraciones/);
});

test('con reporte, una reescritura de verdad pasa', () => {
  const rehecho =
    'La investigación encontró resultados menos parejos que el entusiasmo. Savva y Pérez (2021) obtuvieron para el libro electrónico un efecto global pequeño a su favor. Cuando lo medido era comprender historias, no hubo ninguna diferencia. La escuela, así, ya usaba relatos en pantalla mientras los estudios seguían sin ponerse de acuerdo sobre cuándo servían para entender.';
  assert.equal(motor.comprobarHumanizado(ORIGINAL_MARCADO, rehecho, { estricto: true }), null);
});

test('con reporte, lo fundido va a otro intento con su motivo y se entrega lo que cumple', async () => {
  const fundido =
    'Los resultados de la investigación salieron menos parejos que el entusiasmo inicial, ya que Savva y Pérez (2021) obtuvieron para el libro electrónico un efecto global pequeño a su favor y ninguna diferencia cuando se medía comprender historias, de modo que la escuela ya usaba relatos en pantalla mientras los estudios seguían sin acuerdo sobre cuándo servían.';
  const rehecho =
    'La investigación encontró resultados menos parejos que el entusiasmo. Savva y Pérez (2021) obtuvieron para el libro electrónico un efecto global pequeño a su favor. Cuando lo medido era comprender historias, no hubo ninguna diferencia. La escuela, así, ya usaba relatos en pantalla mientras los estudios seguían sin ponerse de acuerdo sobre cuándo servían para entender.';
  const vistos = [];
  const generar = async (peticion) => {
    const entrada = JSON.parse(peticion.mensajes[0].texto);
    vistos.push(entrada.fallo_anterior ?? null);
    const salida = {};
    for (const clave of Object.keys(entrada.parrafos)) salida[clave] = entrada.fallo_anterior ? rehecho : fundido;
    return { texto: JSON.stringify(salida), uso: { promptTokenCount: 1, candidatesTokenCount: 1 } };
  };
  const { cambios } = await humanizador.humanizar({
    parrafos: [parrafo('9', ORIGINAL_MARCADO)],
    generar,
    modelos: ['falso'],
    conPasada: false,
    soloClaves: new Set(['9']),
  });
  assert.equal(cambios['9'].texto, rehecho);
  assert.match(JSON.stringify(vistos.filter(Boolean)[0]), /menos oraciones/);
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

test('las cifras escritas de otra forma vuelven a la del autor; un dato distinto no', () => {
  const autor = 'Furenes et al. (2021) reunieron 39 estudios con 1812 niños de 1 a 8 años y 149 400 estudiantes.';
  const modelo = 'Con 1 812 niños de uno a ocho años y 149 400 estudiantes, Furenes et al. (2021) reunieron 39 estudios.';
  const reparado = motor.repararCifras(autor, modelo);
  assert.equal(reparado, 'Con 1812 niños de 1 a 8 años y 149 400 estudiantes, Furenes et al. (2021) reunieron 39 estudios.');
  assert.match(motor.repararCifras(autor, 'Con 1 813 niños de uno a nueve años.'), /1 813.*uno a nueve/);
  assert.equal(motor.repararCifras('Uno de los estudios halló dos efectos.', 'Uno de los estudios halló dos efectos.'), 'Uno de los estudios halló dos efectos.');
});

test('una cita con apellido compuesto que cambia de forma sigue siendo una cita', () => {
  const o = 'En Polonia, una encuesta a contadores del sector público atribuyó la exactitud del estado al control interno (García Peña et al., 2023), según el estudio citado aquí con más detalle.';
  const n = 'Según García Peña et al. (2023), una encuesta en Polonia a contadores del sector público atribuyó la exactitud del estado al control interno, como se detalla aquí.';
  assert.equal(motor.comprobar(o, n, { servicio: 'HUMANIZAR' }), null);
  const o2 = 'El cuestionario de cinco niveles que Fonseca Pérez (2022) aplicó a 30 empleados mostró un resultado alto en todos los casos que se revisaron aquí.';
  const n2 = 'Aplicado a 30 empleados, el cuestionario de cinco niveles (Fonseca Pérez, 2022) mostró un resultado alto en todos los casos que se revisaron.';
  assert.equal(motor.comprobar(o2, n2, { servicio: 'HUMANIZAR' }), null);
  // Sin la cita, sigue rechazándose aunque el apellido y el año queden sueltos.
  const n3 = 'Aplicado a 30 empleados, el cuestionario de cinco niveles de Fonseca Pérez, publicado en 2022, mostró un resultado alto en todos los casos.';
  assert.match(motor.comprobar(o2, n3, { servicio: 'HUMANIZAR' }), /dejó de ser una cita/);
});

test('el motivo de las cifras dice solo lo que falta y lo que sobra', () => {
  const o = 'El cuestionario tuvo 21 ítems con una escala de 1, 2, 3, 4 y 5 puntos que se aplicó en 2011 a los empleados del área contable de la empresa.';
  const n = 'Los empleados del área contable respondieron en 2011 un cuestionario de 21 ítems con una escala de 3 niveles, aplicado a todos.';
  const motivo = motor.comprobar(o, n, { servicio: 'HUMANIZAR' });
  assert.match(motivo, /se perdían las cifras 1, 2, 4, 5/);
  assert.doesNotMatch(motivo, /→|21/);
});

'use strict';

/**
 * El motor con R de verdad: `r/ejecutar.R` y `r/preambulo.R` corriendo en
 * Rscript. Sin la jaula —esa solo existe en el servidor y la prueba
 * infra/r/probar-jaula.sh—, pero con todo lo demás.
 *
 * Si en esta máquina no hay R, las pruebas se saltan en vez de fallar: el resto
 * de la batería no puede depender de tener R instalado. RSCRIPT dice dónde está
 * si no va en el PATH.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { crearMotor, conductorLocal } = require('../src/modules/r/r.motor');
const formato = require('../src/modules/r/r.formato');

const RUNNER = path.resolve(__dirname, '../r/ejecutar.R');

function buscarRscript() {
  const candidatos = [process.env.RSCRIPT, 'Rscript'].filter(Boolean);
  if (process.platform === 'win32') {
    const raiz = 'C:\\Program Files\\R';
    try {
      for (const version of fs.readdirSync(raiz).sort().reverse()) {
        candidatos.push(path.join(raiz, version, 'bin', 'Rscript.exe'));
      }
    } catch {
      // Sin R instalado en la ruta de siempre.
    }
  }

  for (const candidato of candidatos) {
    try {
      execFileSync(candidato, ['--version'], { stdio: 'ignore', windowsHide: true });
      return candidato;
    } catch {
      // El siguiente.
    }
  }
  return null;
}

const RSCRIPT = buscarRscript();
const opciones = { skip: RSCRIPT ? false : 'no hay Rscript en esta máquina', timeout: 120_000 };

// Una matriz como la de una tesis, guardada como la guarda el Excel en español.
const MATRIZ =
  'sep=;\r\n' +
  'id;sexo;p1;p2;p3;p4;edad\r\n' +
  [
    [1, 'F', 4, 5, 4, 5, '20,5'],
    [2, 'M', 3, 3, 4, 3, '22'],
    [3, 'F', 5, 5, 5, 4, '19'],
    [4, 'M', 2, 3, 2, 2, '25'],
    [5, 'F', 4, 4, 5, 4, '21'],
    [6, 'M', 3, 2, 3, 3, '23'],
    [7, 'F', 5, 4, 5, 5, '20'],
    [8, 'M', 2, 2, 1, 2, '24'],
    [9, 'F', 4, 5, 4, 4, '22'],
    [10, 'M', 3, 3, 3, 4, '26'],
  ]
    .map((fila) => fila.join(';'))
    .join('\r\n') +
  '\r\n';

async function motorReal(limiteSegundos = 40) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'acosta-r-real-'));
  return crearMotor({
    carpetaBase: base,
    conductor: conductorLocal({ rscript: RSCRIPT, runner: RUNNER, limiteSegundos }),
    limiteSegundos,
  });
}

async function conDatos() {
  const motor = await motorReal();
  const subido = await motor.subirDatos('tesis', formato.preparar(Buffer.from(MATRIZ)));
  return { motor, subido };
}

test('lee el CSV del Excel en español con sus columnas y sus decimales', opciones, async () => {
  const { subido } = await conDatos();

  assert.equal(subido.resultado, 'ok', subido.salida);
  const datos = subido.estado.objetos.find((o) => o.nombre === 'datos');
  assert.equal(datos.detalle, '10 x 7');
  const edad = subido.estado.columnas.find((c) => c.nombre === 'edad');
  assert.equal(edad.clase, 'numeric', 'con la coma decimal mal leída, la edad sería texto');
});

test('las funciones de la casa están y los objetos se conservan entre órdenes', opciones, async () => {
  const { motor } = await conDatos();

  const alfa = await motor.ejecutar('tesis', 'alfa_de_cronbach(datos[, c("p1", "p2", "p3", "p4")])');
  assert.equal(alfa.resultado, 'ok', alfa.salida);
  assert.match(alfa.salida, /Alfa de Cronbach: 0\.\d+/);

  await motor.ejecutar('tesis', 'datos$total <- puntaje(datos, c("p1", "p2", "p3", "p4"))');
  const despues = await motor.ejecutar('tesis', 'cat("media:", round(mean(datos$total), 2), "\\n")');
  assert.match(despues.salida, /media: \d/);

  // Las de la casa no se guardan en la sesión: salen del preámbulo cada vez.
  assert.ok(!despues.estado.objetos.some((o) => o.nombre === 'alfa_de_cronbach'));
});

test('un error para la orden y deja lo anterior en la sesión', opciones, async () => {
  const { motor } = await conDatos();

  const r = await motor.ejecutar('tesis', 'antes <- 1\nstop("esto falla")\ndespues <- 2');
  assert.equal(r.resultado, 'error');
  assert.match(r.salida, /esto falla/);

  const nombres = r.estado.objetos.map((o) => o.nombre);
  assert.ok(nombres.includes('antes'));
  assert.ok(!nombres.includes('despues'));
});

test('un gráfico sale como PNG y un CSV escrito se puede bajar', opciones, async () => {
  const { motor } = await conDatos();

  const r = await motor.ejecutar('tesis', 'hist(datos$p1)\nescribir_csv(datos, "resultados.csv")');
  assert.equal(r.resultado, 'ok', r.salida);
  assert.equal(r.graficos.length, 1);
  assert.equal(r.graficos[0].bytes.subarray(1, 4).toString('latin1'), 'PNG');
  assert.ok(r.archivos.some((a) => a.nombre === 'resultados.csv'));
  assert.ok(await motor.leerArchivo('tesis', 'resultados.csv'));
});

test('R no recibe el entorno del backend', opciones, async () => {
  process.env.SECRETO_DE_PRUEBA_R = 'no-debe-salir';
  try {
    const motor = await motorReal();
    const r = await motor.ejecutar('tesis', 'cat("[", Sys.getenv("SECRETO_DE_PRUEBA_R"), "]\\n")');
    assert.equal(r.resultado, 'ok', r.salida);
    assert.doesNotMatch(r.salida, /no-debe-salir/);
  } finally {
    delete process.env.SECRETO_DE_PRUEBA_R;
  }
});

test('una orden que pasa del límite se corta y la sesión sigue como estaba', opciones, async () => {
  const motor = await motorReal(3);
  await motor.ejecutar('tesis', 'guardado <- 42');

  // Sys.sleep y no un bucle infinito: en Windows, cortar Rscript puede dejar
  // vivo el R que lanzó, y un bucle se quedaría gastando CPU en la máquina.
  const r = await motor.ejecutar('tesis', 'perdido <- 1\nSys.sleep(8)');
  assert.equal(r.resultado, 'tiempo');

  const despues = await motor.ejecutar('tesis', 'cat(guardado, exists("perdido"), "\\n")');
  assert.match(despues.salida, /42 FALSE/);
});

'use strict';

/**
 * El motor de sesiones de R, con un conductor de mentira que hace lo que haría
 * R: escribir la consola, el estado y los gráficos. Así se prueba lo que es del
 * motor —turnos, plazas, guion, y sobre todo que no sigue los enlaces que R
 * pueda dejar— sin necesitar R ni systemd.
 *
 * El R de verdad se prueba en r.motor.real.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { crearMotor, esBibliografica, MotorNoDisponible, MotorOcupado } = require('../src/modules/r/r.motor');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(300, 1)]);

async function carpetaTemporal() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'acosta-r-'));
}

/** Un «R» que responde según lo que hay en orden.R. */
function conductorFalso({ espera = 0, antes } = {}) {
  const llamadas = [];
  const conductor = async ({ sesion, carpeta }) => {
    llamadas.push(sesion);
    const orden = await fs.readFile(path.join(carpeta, 'orden.R'), 'utf8');
    if (antes) await antes({ carpeta, orden });
    if (espera) await new Promise((r) => setTimeout(r, espera));

    if (orden.includes('CORTAR')) return { fallo: 'SIGKILL', stderr: '' };
    if (orden.includes('SIN_PERMISO')) return { fallo: '1', stderr: 'Failed to start: Access denied' };

    const error = orden.includes('stop(');
    await fs.writeFile(path.join(carpeta, 'salida.txt'), `> ${orden}\n${error ? 'Error: fallo' : '[1] 2'}\n`);
    await fs.writeFile(
      path.join(carpeta, 'estado.tsv'),
      'obj\tdatos\tdata.frame\t120 x 3\ncol\tedad\tinteger\t0\t18 45\ncol\tsexo\tcharacter\t2\t2\n',
    );
    if (orden.includes('hist(')) await fs.writeFile(path.join(carpeta, 'graficos', 'grafico-01.png'), PNG);
    if (orden.includes('escribir_csv')) await fs.writeFile(path.join(carpeta, 'resultados.csv'), 'a;b\n');
    await fs.writeFile(path.join(carpeta, 'fin'), error ? 'error' : 'ok');
    return { fallo: null, stderr: '' };
  };
  conductor.llamadas = llamadas;
  return conductor;
}

/** ¿Deja este sistema crear enlaces simbólicos? En Windows sin permisos, no. */
async function puedeEnlazar(carpeta) {
  try {
    await fs.writeFile(path.join(carpeta, 'objetivo'), 'x');
    await fs.symlink(path.join(carpeta, 'objetivo'), path.join(carpeta, 'enlace'));
    await fs.rm(path.join(carpeta, 'enlace'));
    return true;
  } catch {
    return false;
  }
}

test('ejecuta, lee la consola, el estado y los gráficos', async () => {
  const base = await carpetaTemporal();
  const motor = crearMotor({ carpetaBase: base, conductor: conductorFalso() });

  const r = await motor.ejecutar('p1', 'hist(datos$edad)');

  assert.equal(r.resultado, 'ok');
  assert.match(r.salida, /\[1\] 2/);
  assert.deepEqual(r.estado.objetos, [{ nombre: 'datos', clase: 'data.frame', detalle: '120 x 3' }]);
  assert.equal(r.estado.columnas[1].perdidos, 2);
  assert.equal(r.graficos.length, 1);
  assert.equal(r.graficos[0].nombre, 'graficos/grafico-01.png');
});

test('al guion va lo que corrió bien; a la consola, todo', async () => {
  const base = await carpetaTemporal();
  const motor = crearMotor({ carpetaBase: base, conductor: conductorFalso() });

  await motor.ejecutar('p1', 'x <- 1');
  const conError = await motor.ejecutar('p1', 'stop("fallo")');
  const final = await motor.ejecutar('p1', 'y <- 2');

  assert.equal(conError.resultado, 'error');
  assert.match(final.guion, /x <- 1/);
  assert.match(final.guion, /y <- 2/);
  assert.doesNotMatch(final.guion, /stop/, 'lo que falló no se puede repetir en RStudio');
  assert.match(final.consola, /stop\("fallo"\)/);
});

test('los gráficos de la orden anterior no se cuelan en la siguiente', async () => {
  const base = await carpetaTemporal();
  const motor = crearMotor({ carpetaBase: base, conductor: conductorFalso() });

  await motor.ejecutar('p1', 'hist(datos$edad)');
  const siguiente = await motor.ejecutar('p1', 'x <- 1');
  assert.equal(siguiente.graficos.length, 0);
});

test('sin «fin» y antes del límite: se cortó (memoria)', async () => {
  const base = await carpetaTemporal();
  const motor = crearMotor({ carpetaBase: base, conductor: conductorFalso(), limiteSegundos: 45 });
  assert.equal((await motor.ejecutar('p1', 'CORTAR')).resultado, 'cortado');
});

test('sin «fin» y en el límite: se acabó el tiempo', async () => {
  const base = await carpetaTemporal();
  const motor = crearMotor({
    carpetaBase: base,
    conductor: conductorFalso({ espera: 1100 }),
    limiteSegundos: 1,
  });
  assert.equal((await motor.ejecutar('p1', 'CORTAR')).resultado, 'tiempo');
});

test('si systemd no deja arrancar la jaula, el motor no está disponible', async () => {
  const base = await carpetaTemporal();
  const motor = crearMotor({ carpetaBase: base, conductor: conductorFalso() });
  await assert.rejects(motor.ejecutar('p1', 'SIN_PERMISO'), MotorNoDisponible);
});

test('dos órdenes de la misma sesión no se pisan', async () => {
  const base = await carpetaTemporal();
  let dentro = 0;
  let maximo = 0;
  const conductor = conductorFalso({
    espera: 40,
    antes: async () => {
      dentro += 1;
      maximo = Math.max(maximo, dentro);
      await new Promise((r) => setTimeout(r, 20));
      dentro -= 1;
    },
  });
  const motor = crearMotor({ carpetaBase: base, conductor, maxSimultaneas: 4 });

  const [a, b] = await Promise.all([motor.ejecutar('p1', 'a <- 1'), motor.ejecutar('p1', 'b <- 2')]);
  assert.equal(maximo, 1);
  assert.match(b.guion, /a <- 1[\s\S]*b <- 2/, 'la segunda ve lo que dejó la primera');
  assert.equal(a.resultado, 'ok');
});

test('sin plaza libre durante demasiado rato, se avisa en vez de esperar sin fin', async () => {
  const base = await carpetaTemporal();
  // La segunda se lanza cuando la primera YA tiene la plaza: si no, gana la
  // carrera cualquiera de las dos y la prueba no dice nada.
  let dentro;
  const yaDentro = new Promise((resolve) => {
    dentro = resolve;
  });
  const motor = crearMotor({
    carpetaBase: base,
    conductor: conductorFalso({ espera: 300, antes: async () => dentro() }),
    maxSimultaneas: 1,
    esperaMaximaMs: 50,
  });

  const primera = motor.ejecutar('p1', 'a <- 1');
  await yaDentro;
  await assert.rejects(motor.ejecutar('p2', 'b <- 1'), MotorOcupado);
  assert.equal((await primera).resultado, 'ok');
});

test('subir datos empieza una sesión nueva', async () => {
  const base = await carpetaTemporal();
  const motor = crearMotor({ carpetaBase: base, conductor: conductorFalso() });

  await motor.ejecutar('p1', 'viejo <- 1');
  await fs.writeFile(path.join(base, 'p1', 'entorno.RData'), 'objetos de otros datos');

  const r = await motor.subirDatos('p1', {
    archivo: 'datos.csv',
    contenido: Buffer.from('a;b\n1;2\n'),
    lectura: 'datos <- read.csv("datos.csv", sep = ";")',
  });

  assert.doesNotMatch(r.guion, /viejo/);
  assert.match(r.guion, /read\.csv/);
  await assert.rejects(fs.stat(path.join(base, 'p1', 'entorno.RData')), 'el entorno viejo se borra');
  assert.equal((await motor.estado('p1')).hayDatos, true);
});

test('un exporte bibliográfico marca la sesión para la jaula del mapeo; una matriz la desmarca', async () => {
  const base = await carpetaTemporal();
  const motor = crearMotor({ carpetaBase: base, conductor: conductorFalso() });
  const carpeta = path.join(base, 'p1');

  await motor.subirDatos('p1', {
    tipo: 'bibliografia',
    archivo: 'datos.txt',
    contenido: Buffer.from('FN Clarivate Analytics Web of Science\n'),
    lectura: 'datos <- bibliometrix::convert2df("datos.txt", dbsource = "wos", format = "plaintext")',
  });
  assert.equal(await esBibliografica(carpeta), true);
  assert.ok(!(await motor.estado('p1')).archivos.some((a) => a.nombre === 'bibliografia'), 'la marca es interna');

  // Después de reiniciar sigue siendo la misma bibliografía.
  await motor.reiniciar('p1');
  assert.equal(await esBibliografica(carpeta), true);

  await motor.subirDatos('p1', {
    tipo: 'csv',
    archivo: 'datos.csv',
    contenido: Buffer.from('a;b\n1;2\n'),
    lectura: 'datos <- read.csv("datos.csv", sep = ";")',
  });
  assert.equal(await esBibliografica(carpeta), false);
  await assert.rejects(fs.stat(path.join(carpeta, 'datos.txt')), 'el exporte anterior se borra');
});

test('reiniciar sin datos no ejecuta nada', async () => {
  const base = await carpetaTemporal();
  const conductor = conductorFalso();
  const motor = crearMotor({ carpetaBase: base, conductor });
  assert.equal(await motor.reiniciar('p1'), null);
  assert.equal(conductor.llamadas.length, 0);
});

test('los archivos del tesista se listan y se bajan; los internos no', async () => {
  const base = await carpetaTemporal();
  const motor = crearMotor({ carpetaBase: base, conductor: conductorFalso() });
  const r = await motor.ejecutar('p1', 'escribir_csv(datos)\nhist(datos$edad)');

  assert.deepEqual(r.archivos.map((a) => a.nombre), ['resultados.csv']);
  assert.ok(await motor.leerArchivo('p1', 'resultados.csv'));
  assert.ok(await motor.leerArchivo('p1', 'graficos/grafico-01.png'));

  for (const nombre of ['orden.R', 'entorno.RData', '../p2/x', 'graficos/../orden.R', '/etc/passwd', '']) {
    assert.equal(await motor.leerArchivo('p1', nombre), null, nombre);
  }
});

test('una sesión con nombre de ruta no se acepta', async () => {
  const base = await carpetaTemporal();
  const motor = crearMotor({ carpetaBase: base, conductor: conductorFalso() });
  await assert.rejects(motor.ejecutar('../fuera', 'x <- 1'));
  await assert.rejects(motor.estado('a/b'));
});

// ── Lo que escribe R no es de fiar ──────────────────────────────────────────

test('si R deja la consola como enlace a un secreto, el secreto no sale', async (t) => {
  const base = await carpetaTemporal();
  if (!(await puedeEnlazar(base))) return t.skip('este sistema no deja crear enlaces simbólicos');

  const secreto = path.join(base, 'fuera.env');
  await fs.writeFile(secreto, 'DATABASE_URL=mysql://secreto');

  const conductor = async ({ carpeta }) => {
    await fs.symlink(secreto, path.join(carpeta, 'salida.txt'));
    await fs.symlink(secreto, path.join(carpeta, 'estado.tsv'));
    await fs.writeFile(path.join(carpeta, 'fin'), 'ok');
    return { fallo: null, stderr: '' };
  };
  const motor = crearMotor({ carpetaBase: base, conductor });
  const r = await motor.ejecutar('p1', 'x <- 1');

  assert.doesNotMatch(r.salida, /secreto/);
  assert.deepEqual(r.estado.objetos, []);
  assert.doesNotMatch(r.consola, /secreto/);
});

test('si R cambia orden.R por un enlace, el backend no escribe a través de él', async (t) => {
  const base = await carpetaTemporal();
  if (!(await puedeEnlazar(base))) return t.skip('este sistema no deja crear enlaces simbólicos');

  const victima = path.join(base, 'no-tocar.txt');
  await fs.writeFile(victima, 'original');
  const motor = crearMotor({ carpetaBase: base, conductor: conductorFalso() });

  await motor.ejecutar('p1', 'x <- 1');
  for (const nombre of ['orden.R', 'guion.R', 'consola.txt']) {
    await fs.rm(path.join(base, 'p1', nombre), { force: true });
    await fs.symlink(victima, path.join(base, 'p1', nombre));
  }
  await motor.ejecutar('p1', 'y <- 2');

  assert.equal(await fs.readFile(victima, 'utf8'), 'original');
});

test('si R cambia la carpeta de gráficos por un enlace, no se leen sus archivos', async () => {
  const base = await carpetaTemporal();

  const ajena = path.join(base, 'ajena');
  await fs.mkdir(ajena);
  await fs.writeFile(path.join(ajena, 'grafico-01.png'), PNG);

  const conductor = async ({ carpeta }) => {
    await fs.rm(path.join(carpeta, 'graficos'), { recursive: true, force: true });
    // Un «junction» en Windows, que no pide permisos; un enlace normal en Linux.
    await fs.symlink(ajena, path.join(carpeta, 'graficos'), 'junction');
    await fs.writeFile(path.join(carpeta, 'fin'), 'ok');
    return { fallo: null, stderr: '' };
  };
  const motor = crearMotor({ carpetaBase: base, conductor });
  const r = await motor.ejecutar('p1', 'x <- 1');

  assert.equal(r.graficos.length, 0);
  assert.equal(await motor.leerArchivo('p1', 'graficos/grafico-01.png'), null);
});

// ── Disco ───────────────────────────────────────────────────────────────────

test('se mide lo que ocupa la sesión, para poder avisar antes de llenar el disco', async () => {
  const base = await carpetaTemporal();
  const conductor = conductorFalso({
    antes: async ({ carpeta, orden }) => {
      if (orden.includes('pesado')) await fs.writeFile(path.join(carpeta, 'pesado.bin'), Buffer.alloc(300 * 1024));
    },
  });
  const motor = crearMotor({ carpetaBase: base, conductor });

  const r = await motor.ejecutar('p1', 'pesado <- 1');
  assert.ok(r.ocupados >= 300 * 1024, `midió ${r.ocupados}`);
});

test('una sesión con cientos de archivos no se lista entera', async () => {
  const base = await carpetaTemporal();
  const conductor = conductorFalso({
    antes: async ({ carpeta, orden }) => {
      if (!orden.includes('muchos')) return;
      for (let i = 0; i < 260; i += 1) await fs.writeFile(path.join(carpeta, `f${String(i).padStart(3, '0')}.txt`), 'x');
    },
  });
  const motor = crearMotor({ carpetaBase: base, conductor });

  const r = await motor.ejecutar('p1', 'muchos <- 1');
  assert.ok(r.archivos.length <= 200, `listó ${r.archivos.length}`);
  assert.ok(r.archivos.length > 0);
});

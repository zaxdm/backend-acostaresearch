'use strict';

/**
 * SPSS en la conversación (r.spss): el filtro de la sintaxis, el motor con un
 * R y un PSPP de mentira, y lo que la herramienta le cuenta a Claude.
 *
 * PSPP de verdad, dentro de su jaula, lo prueba infra/r/probar-jaula.sh; el
 * paso de los datos a .sav con R de verdad, r.spss.real.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const rutaRepo = require.resolve('../src/modules/projects/project.repository');
const rutaProyectos = require.resolve('../src/modules/projects/project.service');
const guardados = [];
const falso = (ruta, exports) => {
  require.cache[ruta] = { id: ruta, filename: ruta, loaded: true, exports };
};
falso(rutaRepo, {
  asegurar: async () => ({ id: 'proyecto-1' }),
  buscar: async () => ({ id: 'proyecto-1' }),
});
falso(rutaProyectos, {
  recibirAnalisis: async (datos) => {
    guardados.push(datos);
    return { capitulo: 'analisis-datos-rstudio', escritos: ['script', 'salida'] };
  },
});

const spss = require('../src/modules/r/r.spss');
const rService = require('../src/modules/r/r.service');
const { crearMotor, MotorNoDisponible, ARGUMENTOS_PSPP } = require('../src/modules/r/r.motor');

const USO = { userId: 'u1', productCode: 'METODO_9_SKILLS' };
const textoDe = (contenido) => contenido.content.find((c) => c.type === 'text').text;

// ── El filtro ───────────────────────────────────────────────────────────────

test('la sintaxis normal de una tesis pasa el filtro', () => {
  const sintaxis = [
    'RELIABILITY /VARIABLES=p1 p2 p3 p4 /MODEL=ALPHA.',
    'COMPUTE total = SUM(p1 TO p4).',
    'EXAMINE VARIABLES=total /PLOT NPPLOT.',
    "VALUE LABELS sexo 1 'Hombre' 2 'Mujer/otro'.",
    'NONPAR CORR /VARIABLES=total edad /PRINT=SPEARMAN.',
    "SAVE OUTFILE='resultados.sav'.",
    '* HOST en un comentario no es un comando.',
  ].join('\n');
  assert.equal(spss.revisar(sintaxis), null);
});

test('HOST, ERASE, INCLUDE y las rutas de fuera no pasan', () => {
  assert.equal(spss.revisar("HOST COMMAND=['cat /etc/passwd'].").regla, 'spss-host');
  assert.equal(spss.revisar("  erase FILE='datos-spss.sav'.").regla, 'spss-borrar');
  assert.equal(spss.revisar("INSERT FILE='otro.sps'.").regla, 'spss-incluir');
  assert.equal(spss.revisar("FILE HANDLE h /NAME='/etc'.").regla, 'spss-archivos');
  assert.equal(spss.revisar("GET FILE='/opt/acostaresearch/app/.env'.").regla, 'spss-ruta');
  assert.equal(spss.revisar("SAVE OUTFILE='../otra-sesion/x.sav'.").regla, 'spss-ruta');
  assert.equal(spss.revisar("GET DATA /TYPE=TXT /FILE='|cat /etc/shadow'.").regla, 'spss-ruta');
});

test('la orden abre los datos de la sesión antes de la sintaxis', () => {
  assert.equal(spss.armarOrden('DESCRIPTIVES edad.\r\n'), "GET FILE='datos-spss.sav'.\nDESCRIPTIVES edad.\n");
});

test('se leen los nombres cambiados y los errores de PSPP', () => {
  const salida = '> cat(...)\nRENOMBRADA Edad..años. -> Edad..años\nRENOMBRADA AND -> AND_\nSPSS-LISTO 7 casos 2 variables\n';
  assert.deepEqual(spss.renombradas(salida), [
    { antes: 'Edad..años.', ahora: 'Edad..años' },
    { antes: 'AND', ahora: 'AND_' },
  ]);
  assert.equal(spss.hayErrores('orden.sps:2.1-2.12: error: DESCRIPTIVES: x is not a variable name.'), true);
  assert.equal(spss.hayErrores('orden.sps:3: warning: something minor.'), false);
});

test('la unidad del servidor y el desarrollo llaman a PSPP con las mismas opciones', async () => {
  const unidad = await fs.readFile(path.join(__dirname, '../infra/r/pspp.conf'), 'utf8');
  const linea = unidad.split('\n').find((l) => l.startsWith('ExecStart=/'));
  assert.equal(linea, `ExecStart=/usr/bin/pspp ${ARGUMENTOS_PSPP.join(' ')}`);
});

// ── El motor ────────────────────────────────────────────────────────────────

async function carpetaTemporal() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'acosta-spss-'));
}

/** Un «R» que hace lo justo: escribe el .sav cuando se lo piden. */
function rFalso({ renombrar = false, sinTabla = false } = {}) {
  return async ({ carpeta }) => {
    const orden = await fs.readFile(path.join(carpeta, 'orden.R'), 'utf8');
    let salida = '> orden\n';
    let fin = 'ok';
    if (orden.includes('write_sav')) {
      if (sinTabla) {
        salida += "Error: No hay una tabla 'datos' en la sesion\n";
        fin = 'error';
      } else {
        if (renombrar) salida += 'RENOMBRADA AND -> AND_\n';
        await fs.writeFile(path.join(carpeta, 'datos-spss.sav'), 'sav');
        salida += 'SPSS-LISTO 7 casos 2 variables\n';
      }
    }
    await fs.writeFile(path.join(carpeta, 'salida.txt'), salida);
    await fs.writeFile(path.join(carpeta, 'estado.tsv'), 'obj\tdatos\tdata.frame\t7 x 2\n');
    await fs.writeFile(path.join(carpeta, 'fin'), fin);
    return { fallo: null, stderr: '' };
  };
}

/** Un «PSPP» que responde según la sintaxis. */
function psppFalso() {
  const ordenes = [];
  const conductor = async ({ carpeta }) => {
    const orden = await fs.readFile(path.join(carpeta, 'orden.sps'), 'utf8');
    ordenes.push(orden);
    if (orden.includes('NO_INSTALADO')) return { fallo: '5', stderr: 'Unit acostaresearch-r-pspp@p1.service not found.' };
    const mal = orden.includes('MAL');
    await fs.writeFile(path.join(carpeta, 'salida-spss.txt'), 'Descriptive Statistics\nedad  N 7  Mean 26.00\n');
    await fs.writeFile(
      path.join(carpeta, 'errores-spss.txt'),
      mal ? 'orden.sps:2.1-2.3: error: Unknown command `MAL\'.\n' : '',
    );
    await fs.writeFile(path.join(carpeta, 'resultados-spss.odt'), 'odt');
    return { fallo: mal ? '1' : null, stderr: '' };
  };
  conductor.ordenes = ordenes;
  return conductor;
}

async function motorConDatos(opciones = {}) {
  const base = await carpetaTemporal();
  const pspp = psppFalso();
  const motor = crearMotor({ carpetaBase: base, conductor: rFalso(opciones), conductorSpss: pspp });
  await motor.subirDatos('p1', {
    archivo: 'datos.csv',
    contenido: 'edad,nota\n18,12\n',
    lectura: 'datos <- read.csv("datos.csv")',
  });
  return { motor, base, pspp };
}

test('ejecuta la sintaxis sobre el .sav de la sesión y la acumula', async () => {
  const { motor, base, pspp } = await motorConDatos();

  const r = await motor.ejecutarSpss('p1', 'DESCRIPTIVES edad.');

  assert.equal(r.resultado, 'ok');
  assert.match(r.salida, /Descriptive Statistics/);
  assert.equal(pspp.ordenes[0], "GET FILE='datos-spss.sav'.\nDESCRIPTIVES edad.\n");
  assert.match(r.sintaxis, /^\* Sintaxis de SPSS/);
  assert.match(r.sintaxis, /GET FILE='datos-spss.sav'\.\n\nDESCRIPTIVES edad\.\n$/);
  assert.match(r.consola, /── SPSS \(PSPP\) ──\nDESCRIPTIVES edad\./);
  // Al tesista le quedan el .sav, la sintaxis y las tablas; lo interno, no.
  const nombres = r.archivos.map((a) => a.nombre);
  assert.deepEqual(nombres.filter((n) => /spss|\.sps|\.odt/.test(n)).sort(), [
    'datos-spss.sav',
    'resultados-spss.odt',
    'sintaxis.sps',
  ]);
  assert.equal(await motor.leerArchivo('p1', 'orden.sps'), null);
  assert.equal(await motor.leerArchivo('p1', 'errores-spss.txt'), null);
  assert.ok(await motor.leerArchivo('p1', 'sintaxis.sps'));
  await fs.rm(base, { recursive: true, force: true });
});

test('lo que da error no entra en la sintaxis acumulada, pero sí en la consola', async () => {
  const { motor, base } = await motorConDatos();
  await motor.ejecutarSpss('p1', 'DESCRIPTIVES edad.');

  const r = await motor.ejecutarSpss('p1', 'MAL.');

  assert.equal(r.resultado, 'error');
  assert.match(r.salida, /MENSAJES DE PSPP:\n.*Unknown command/);
  assert.doesNotMatch(r.sintaxis, /MAL/);
  assert.match(r.consola, /MAL\./);
  await fs.rm(base, { recursive: true, force: true });
});

test('el paso a .sav no borra las figuras que el análisis dejó en graficos/', async () => {
  const { motor, base } = await motorConDatos();
  const figura = path.join(base, 'p1', 'graficos', 'figura1.png');
  await fs.writeFile(figura, Buffer.alloc(200, 1));

  await motor.ejecutarSpss('p1', 'DESCRIPTIVES edad.');

  assert.ok(await fs.stat(figura));
  await fs.rm(base, { recursive: true, force: true });
});

test('si R no puede pasar los datos, PSPP no corre y se dice por qué', async () => {
  const { motor, base, pspp } = await motorConDatos({ sinTabla: true });

  const r = await motor.ejecutarSpss('p1', 'DESCRIPTIVES edad.');

  assert.equal(r.resultado, 'datos');
  assert.match(r.salida, /No hay una tabla 'datos'/);
  assert.equal(pspp.ordenes.length, 0);
  await fs.rm(base, { recursive: true, force: true });
});

test('sin datos, sin PSPP configurado o sin PSPP instalado, no se ejecuta nada', async () => {
  const base = await carpetaTemporal();
  const motor = crearMotor({ carpetaBase: base, conductor: rFalso(), conductorSpss: psppFalso() });
  assert.deepEqual(await motor.ejecutarSpss('p1', 'DESCRIPTIVES edad.'), { sinDatos: true });

  const sinPspp = crearMotor({ carpetaBase: base, conductor: rFalso() });
  assert.equal(sinPspp.spssDisponible(), false);
  await assert.rejects(sinPspp.ejecutarSpss('p1', 'DESCRIPTIVES edad.'), MotorNoDisponible);

  const { motor: conDatos, base: otra } = await motorConDatos();
  await assert.rejects(conDatos.ejecutarSpss('p1', 'NO_INSTALADO.'), MotorNoDisponible);
  await fs.rm(base, { recursive: true, force: true });
  await fs.rm(otra, { recursive: true, force: true });
});

test('subir otros datos borra el .sav, la sintaxis y las tablas de antes', async () => {
  const { motor, base } = await motorConDatos();
  await motor.ejecutarSpss('p1', 'DESCRIPTIVES edad.');

  await motor.subirDatos('p1', { archivo: 'datos.csv', contenido: 'x\n1\n', lectura: 'datos <- read.csv("datos.csv")' });

  const nombres = (await motor.estado('p1')).archivos.map((a) => a.nombre);
  assert.deepEqual(nombres.filter((n) => /spss|\.sps|\.odt/.test(n)), []);
  await fs.rm(base, { recursive: true, force: true });
});

// ── La herramienta ──────────────────────────────────────────────────────────

function motorDeServicio({ resultado = 'ok', renombradas = [], disponible = true, lanzar } = {}) {
  const motor = {
    llamadas: [],
    async listo() {
      return true;
    },
    spssDisponible: () => disponible,
    async ejecutarSpss(sesion, sintaxis) {
      if (lanzar) throw lanzar;
      motor.llamadas.push({ sesion, sintaxis });
      return {
        resultado,
        salida: 'Descriptive Statistics\nedad N 7 Mean 26.00',
        estado: { objetos: [], columnas: [] },
        graficos: [],
        totalGraficos: 0,
        archivos: [{ nombre: 'datos-spss.sav', bytes: 900 }],
        renombradas,
        guion: '# guion\nx <- 1\n',
        consola: '── SPSS (PSPP) ──\nDESCRIPTIVES edad.\n',
        sintaxis: "* Sintaxis\nGET FILE='datos-spss.sav'.\n\nDESCRIPTIVES edad.\n",
      };
    },
    async ejecutar() {
      throw new Error('no debía correr R');
    },
  };
  return motor;
}

test('spss ejecuta en PSPP, avisa de los nombres cambiados y guarda la sintaxis en el análisis', async () => {
  const motor = motorDeServicio({ renombradas: [{ antes: 'AND', ahora: 'AND_' }] });
  rService.usarMotor(motor);
  guardados.length = 0;

  const { contenido, bloqueo } = await rService.trabajar({ ...USO, spss: ' DESCRIPTIVES edad. ' });
  const texto = textoDe(contenido);

  assert.equal(bloqueo, undefined);
  assert.deepEqual(motor.llamadas, [{ sesion: 'proyecto-1', sintaxis: 'DESCRIPTIVES edad.' }]);
  assert.match(texto, /SALIDA DE PSPP:\nDescriptive Statistics/);
  assert.match(texto, /AND → AND_/);
  assert.match(texto, /datos-spss\.sav.*sintaxis\.sps.*resultados-spss\.odt/s);
  assert.match(texto, /nunca escribas que se usó IBM SPSS/);
  assert.match(guardados[0].script, /^# guion\nx <- 1\n\n# ── Sintaxis de SPSS/);
  assert.match(guardados[0].script, /^# DESCRIPTIVES edad\.$/m);
  rService.usarMotor(null);
});

test('spss bloqueado, mezclado con codigo o sin PSPP no llega al motor', async () => {
  const motor = motorDeServicio();
  rService.usarMotor(motor);

  const bloqueado = await rService.trabajar({ ...USO, spss: "HOST COMMAND=['ls']." });
  assert.equal(bloqueado.bloqueo.regla, 'spss-host');
  assert.match(textoDe(bloqueado.contenido), /NO SE EJECUTÓ/);

  const mezclado = await rService.trabajar({ ...USO, spss: 'DESCRIPTIVES edad.', codigo: 'x <- 1' });
  assert.match(textoDe(mezclado.contenido), /manda spss solo/);
  assert.equal(motor.llamadas.length, 0);

  rService.usarMotor(motorDeServicio({ disponible: false }));
  const sinPspp = await rService.trabajar({ ...USO, spss: 'DESCRIPTIVES edad.' });
  assert.match(textoDe(sinPspp.contenido), /no está disponible/);

  rService.usarMotor(motorDeServicio({ lanzar: new MotorNoDisponible('Unit not found') }));
  const caido = await rService.trabajar({ ...USO, spss: 'DESCRIPTIVES edad.' });
  assert.match(textoDe(caido.contenido), /Haz ese mismo análisis con codigo en R/);
  rService.usarMotor(null);
});

test('el guion guardado sin sintaxis de SPSS queda igual', () => {
  assert.equal(rService.guionConSintaxis('# guion\n', null), '# guion\n');
});

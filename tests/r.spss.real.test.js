'use strict';

/**
 * El paso de los datos de la sesión a .sav (r.spss, EXPORTAR) con R de verdad:
 * nombres que SPSS no acepta y las etiquetas del .sav que subió el tesista.
 * PSPP aquí es de mentira —en esta máquina no hay—; el de verdad lo prueba
 * infra/r/probar-jaula.sh. Sin R, se salta.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const { crearMotor } = require('../src/modules/r/r.motor');
const formato = require('../src/modules/r/r.formato');

const RUNNER = path.resolve(__dirname, '../r/ejecutar.R');

function buscarRscript() {
  const candidatos = [process.env.RSCRIPT, 'Rscript'].filter(Boolean);
  if (process.platform === 'win32') {
    try {
      for (const version of fs.readdirSync('C:\\Program Files\\R').sort().reverse()) {
        candidatos.push(path.join('C:\\Program Files\\R', version, 'bin', 'Rscript.exe'));
      }
    } catch {
      // Sin R en la ruta de siempre.
    }
  }
  for (const candidato of candidatos) {
    try {
      execFileSync(candidato, ['-e', 'stopifnot(requireNamespace("haven", quietly = TRUE))'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return candidato;
    } catch {
      // El siguiente.
    }
  }
  return null;
}

const RSCRIPT = buscarRscript();
const opciones = { skip: RSCRIPT ? false : 'no hay Rscript con haven en esta máquina', timeout: 120_000 };

/** Un PSPP que no hace nada: solo importa lo que R dejó antes. */
const psppQuieto = async ({ carpeta }) => {
  await fsp.writeFile(path.join(carpeta, 'salida-spss.txt'), 'ok\n');
  return { fallo: null, stderr: '' };
};

/**
 * La carpeta de haven. En el servidor está en la biblioteca del sistema; en un
 * Windows de desarrollo suele estar en la del usuario, que el conductor local
 * no ve porque arranca R con un entorno vacío.
 */
const BIBLIOTECA = RSCRIPT
  ? path.dirname(
      execFileSync(RSCRIPT, ['-e', 'cat(find.package("haven"))'], { windowsHide: true, encoding: 'utf8' }).trim(),
    )
  : null;

/** Como el conductor local, pero con esa biblioteca a la vista (R_LIBS). */
function conductorConHaven() {
  return ({ carpeta }) =>
    new Promise((resolve) => {
      const entorno = { LANG: 'C.UTF-8', HOME: carpeta, TMPDIR: carpeta, R_LIBS: BIBLIOTECA };
      for (const clave of ['SystemRoot', 'windir', 'TEMP', 'TMP', 'PATH']) {
        if (process.env[clave]) entorno[clave] = process.env[clave];
      }
      execFile(RSCRIPT, ['--vanilla', RUNNER], { cwd: carpeta, env: entorno, windowsHide: true, timeout: 60_000 }, (error) =>
        resolve({ fallo: error ? String(error.code ?? 'error') : null, stderr: '' }),
      );
    });
}

async function motorReal() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'acosta-spss-real-'));
  const motor = crearMotor({
    carpetaBase: base,
    conductor: conductorConHaven(),
    conductorSpss: psppQuieto,
    limiteSegundos: 60,
  });
  return { motor, base };
}

test('los nombres que SPSS no acepta se cambian y se avisa', opciones, async () => {
  const { motor, base } = await motorReal();
  const csv = 'Edad (años);AND;1item;Género\n20;1;3;F\n22;2;4;M\n';
  await motor.subirDatos('tesis', formato.preparar(Buffer.from(csv)));

  const r = await motor.ejecutarSpss('tesis', 'DESCRIPTIVES ALL.');
  assert.equal(r.resultado, 'ok', r.salida);
  const cambios = Object.fromEntries(r.renombradas.map((c) => [c.antes, c.ahora]));
  assert.equal(cambios.AND, 'AND_');
  assert.match(cambios['Edad..años.'] ?? '', /^Edad..años$/);

  const leido = await motor.ejecutar('tesis', 'cat("NOMBRES:", names(haven::read_sav("datos-spss.sav")), "\\n")');
  const nombres = /NOMBRES: (.*)/.exec(leido.salida)[1].trim().split(/\s+/);
  for (const nombre of nombres) {
    assert.match(nombre, /^[\p{L}@#$][\p{L}\p{N}_.@#$]*[^.]$/u, `«${nombre}» no vale en SPSS`);
    assert.ok(Buffer.byteLength(nombre) <= 64);
  }
  assert.ok(nombres.includes('Género'), nombres.join(' '));
  await fsp.rm(base, { recursive: true, force: true });
});

test('las etiquetas del .sav que subió vuelven al .sav de SPSS, con lo calculado en R', opciones, async () => {
  const { motor, base } = await motorReal();
  const original = path.join(base, 'original.sav');
  execFileSync(
    RSCRIPT,
    [
      '-e',
      `haven::write_sav(data.frame(p1 = haven::labelled(c(1, 2, 5), c("Nunca" = 1, "A veces" = 2, "Siempre" = 5), label = "Pregunta 1"), edad = c(20, 30, 40)), "${original.replace(/\\/g, '/')}")`,
    ],
    { windowsHide: true },
  );
  await motor.subirDatos('tesis', formato.preparar(await fsp.readFile(original)));
  await motor.ejecutar('tesis', 'datos$total <- datos$p1 * 2');

  const r = await motor.ejecutarSpss('tesis', 'FREQUENCIES p1.');
  assert.equal(r.resultado, 'ok', r.salida);
  assert.deepEqual(r.renombradas, []);

  const leido = await motor.ejecutar(
    'tesis',
    'x <- haven::read_sav("datos-spss.sav"); cat("ETIQUETAS:", names(attr(x$p1, "labels")), "|", attr(x$p1, "label"), "|", names(x), "\\n")',
  );
  assert.match(leido.salida, /ETIQUETAS: Nunca A veces Siempre \| Pregunta 1 \| p1 edad total/);
  await fsp.rm(base, { recursive: true, force: true });
});

'use strict';

/**
 * Las sesiones de R de los tesistas: una carpeta por proyecto y un proceso por
 * orden.
 *
 * CÓMO FUNCIONA
 * -------------
 * Cada proyecto tiene su carpeta. Para ejecutar, se deja el código en `orden.R`
 * y se arranca `r/ejecutar.R` con esa carpeta como directorio de trabajo; el
 * guion recupera los objetos de `entorno.RData`, ejecuta, y deja la consola, el
 * estado y los gráficos en archivos. Un proceso por orden y ninguno vivo entre
 * medias: ver la cabecera de `r/ejecutar.R`.
 *
 * Quién arranca el proceso lo decide el «conductor»:
 *
 *   - `systemd`: en el servidor. `systemctl start acostaresearch-r@<sesión>`,
 *     que corre R dentro de la jaula (infra/r/). El backend no puede elegir
 *     cómo es la jaula: solo arrancar la plantilla, y así lo deja polkit.
 *   - `local`: en desarrollo, Rscript a pelo. El arranque lo impide en
 *     producción (ver `config/env`).
 *
 * LO QUE ESCRIBE R NO ES DE FIAR
 * ------------------------------
 * El backend lee y escribe en una carpeta donde también escribe R, y R ejecuta
 * lo que le manden. Si R deja `salida.txt` como un enlace simbólico a
 * `/opt/acostaresearch/app/.env`, dentro de la jaula ese destino no existe, pero
 * FUERA sí, y el backend —que puede leer el .env— lo leería y se lo daría a
 * Claude. Por eso aquí nunca se sigue un enlace: se lee solo lo que `lstat` dice
 * que es un archivo normal, se abre con O_NOFOLLOW, y se escribe creando un
 * temporal con nombre aleatorio y renombrándolo encima, que sustituye el enlace
 * en vez de escribir a través de él.
 *
 * EL GRUPO, SIN EL BIT SETGID
 * ---------------------------
 * El backend y R comparten un grupo (`acosta-r`): así R lee lo que deja el
 * backend y el backend lee lo que devuelve R. Lo natural sería marcar las
 * carpetas con setgid para que todo herede ese grupo, pero la unidad de la API
 * lleva `RestrictSUIDSGID=yes`, y crear o cambiar una carpeta con ese bit da
 * EPERM. Pasó el 14 de septiembre de 2026: la herramienta decía «no disponible»
 * sin llegar a crear nada. Por eso el grupo se pone a mano con `chown` —cambiar
 * al grupo propio no es un privilegio y esa restricción no lo toca— copiándolo
 * de la carpeta de sesiones.
 */

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

/** Nombres de carpeta de sesión: el id del proyecto, que pone la base. */
const SESION_SEGURA = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
/** Nombres de archivo que se leen o se ofrecen para bajar. */
const ARCHIVO_SEGURO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const GRAFICO = /^grafico-\d{2,}\.png$/;

/** Lo que usa el motor y no es del tesista: no se ofrece para bajar. */
const INTERNOS = new Set([
  'orden.R',
  'salida.txt',
  'estado.tsv',
  'fin',
  'entorno.RData',
  'entorno.RData.parcial',
  'guion.R',
  'consola.txt',
  'lectura.R',
  'paquetes.txt',
]);

const MAXIMO_SALIDA = 2 * 1024 * 1024;
const MAXIMO_ESTADO = 512 * 1024;
const MAXIMO_GRAFICO = 1536 * 1024;
const MAXIMO_DESCARGA = 20 * 1024 * 1024;
/** Lo que se guarda del guion y la consola acumulados, contado desde el final. */
const MAXIMO_ACUMULADO = 200 * 1024;
const GRAFICOS_POR_RESPUESTA = 4;

/**
 * Borrar con reintentos. En Windows, un archivo que un proceso recién muerto
 * todavía no ha soltado da EBUSY durante unos milisegundos.
 */
const BORRAR = { force: true, maxRetries: 5, retryDelay: 100 };

const CABECERA_GUION =
  '# Guion de análisis · escrito en la conversación con Claude\n' +
  '# Para repetirlo en RStudio: pon tu archivo de datos en la misma carpeta que este guion.\n\n';

/** El motor no está instalado o no se le deja arrancar: no es culpa del código. */
class MotorNoDisponible extends Error {}
/** Todas las plazas ocupadas durante demasiado rato. */
class MotorOcupado extends Error {}

// ── Archivos, sin seguir enlaces ────────────────────────────────────────────

const O_NOFOLLOW = fsSync.constants.O_NOFOLLOW ?? 0;

/** Lee un archivo normal, hasta `maximo` bytes. null si no existe o no es un archivo normal. */
async function leerSeguro(ruta, maximo) {
  let info;
  try {
    info = await fs.lstat(ruta);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile()) return null;

  let manejador;
  try {
    manejador = await fs.open(ruta, fsSync.constants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    // ELOOP: se cambió por un enlace entre el lstat y el open.
    if (error.code === 'ENOENT' || error.code === 'ELOOP') return null;
    throw error;
  }

  try {
    const tamano = Math.min(info.size, maximo);
    const bytes = Buffer.alloc(tamano);
    const { bytesRead } = await manejador.read(bytes, 0, tamano, 0);
    return { bytes: bytes.subarray(0, bytesRead), truncado: info.size > maximo, tamano: info.size };
  } finally {
    await manejador.close();
  }
}

async function leerTexto(ruta, maximo) {
  const leido = await leerSeguro(ruta, maximo);
  return leido ? leido.bytes.toString('utf8') : null;
}

/**
 * Pone el grupo compartido. Sin grupo conocido —en desarrollo— no hace nada, y
 * un fallo tampoco para nada: en Windows chown no existe.
 */
async function ponerGrupo(ruta, gid) {
  if (gid === null || gid === undefined) return;
  await fs.chown(ruta, -1, gid).catch(() => {});
}

/**
 * Escribe en un temporal nuevo y lo renombra encima: nunca a través de un enlace.
 * El temporal lleva el grupo compartido antes de aparecer con su nombre, para
 * que R pueda leerlo.
 */
async function escribirSeguro(carpeta, nombre, contenido, gid = null) {
  const temporal = path.join(carpeta, `.escribiendo-${crypto.randomBytes(8).toString('hex')}`);
  await fs.writeFile(temporal, contenido, { flag: 'wx', mode: 0o660 });
  await ponerGrupo(temporal, gid);
  await fs.rename(temporal, path.join(carpeta, nombre));
}

/**
 * Una carpeta de verdad en esa ruta, que el backend y R pueden usar.
 *
 * 770 y el grupo compartido; nadie más entra. SIN el bit setgid: ver la
 * cabecera. Si en su lugar hay un enlace o un archivo, se quita.
 */
async function asegurarCarpeta(ruta, gid = null) {
  try {
    const info = await fs.lstat(ruta);
    if (info.isDirectory()) return;
    await fs.rm(ruta, BORRAR);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(ruta, { mode: 0o770 });
  // El umask de la API quita la escritura del grupo al crear: se devuelve.
  await fs.chmod(ruta, 0o770).catch(() => {});
  await ponerGrupo(ruta, gid);
}

/** Vacía una carpeta. `fs.rm` no sigue enlaces: borra el enlace, no su destino. */
async function vaciar(carpeta) {
  const entradas = await fs.readdir(carpeta).catch(() => []);
  await Promise.all(
    entradas.map((n) => fs.rm(path.join(carpeta, n), { ...BORRAR, recursive: true })),
  );
}

// ── Lo que dejó R ───────────────────────────────────────────────────────────

/** `estado.tsv` a objetos y columnas. Ver el final de `r/ejecutar.R`. */
function parsearEstado(texto) {
  const objetos = [];
  const columnas = [];

  for (const linea of String(texto ?? '').split(/\r?\n/)) {
    const campos = linea.split('\t');
    if (campos[0] === 'obj' && campos.length >= 3) {
      objetos.push({ nombre: campos[1], clase: campos[2], detalle: campos[3] ?? '' });
    } else if (campos[0] === 'col' && campos.length >= 4) {
      columnas.push({
        nombre: campos[1],
        clase: campos[2],
        perdidos: Number(campos[3]) || 0,
        resumen: campos[4] ?? '',
      });
    }
  }

  return { objetos, columnas };
}

async function leerGraficos(carpeta) {
  let info;
  try {
    info = await fs.lstat(carpeta);
  } catch {
    return { imagenes: [], total: 0 };
  }
  if (!info.isDirectory()) return { imagenes: [], total: 0 };

  const nombres = (await fs.readdir(carpeta)).filter((n) => GRAFICO.test(n)).sort();
  const imagenes = [];

  for (const nombre of nombres) {
    if (imagenes.length >= GRAFICOS_POR_RESPUESTA) break;
    const leido = await leerSeguro(path.join(carpeta, nombre), MAXIMO_GRAFICO);
    // Un PNG de menos de cien bytes es un dispositivo que se abrió sin dibujar.
    if (!leido || leido.truncado || leido.bytes.length < 100) continue;
    imagenes.push({ nombre: `graficos/${nombre}`, bytes: leido.bytes });
  }

  return { imagenes, total: nombres.length };
}

/** Los archivos que ha creado el tesista, con su tamaño. Sin enlaces ni internos. */
async function listarArchivos(carpeta) {
  const entradas = await fs.readdir(carpeta, { withFileTypes: true }).catch(() => []);
  const archivos = [];

  for (const entrada of entradas) {
    const nombre = entrada.name;
    if (!entrada.isFile() || INTERNOS.has(nombre) || !ARCHIVO_SEGURO.test(nombre)) continue;
    if (/^datos\.(?:csv|xlsx|xls|sav)$/.test(nombre)) continue;
    const info = await fs.lstat(path.join(carpeta, nombre)).catch(() => null);
    if (info?.isFile()) archivos.push({ nombre, bytes: info.size });
  }

  return archivos.sort((a, b) => a.nombre.localeCompare(b.nombre));
}

/** Los últimos `maximo` bytes de un texto, cortando por una línea entera. */
function cola(texto, maximo = MAXIMO_ACUMULADO) {
  if (Buffer.byteLength(texto, 'utf8') <= maximo) return texto;
  const corte = texto.slice(-maximo);
  const salto = corte.indexOf('\n');
  return salto === -1 ? corte : corte.slice(salto + 1);
}

// ── Conductores ─────────────────────────────────────────────────────────────

const NO_DISPONIBLE =
  /access denied|authentication required|not found|not loaded|no such file|failed to connect to bus|permission denied/i;

/**
 * En el servidor: arranca la plantilla de systemd.
 *
 * `systemctl start` de un servicio `oneshot` espera a que termine, así que la
 * llamada dura lo que dura R. El tiempo de verdad lo corta systemd
 * (`TimeoutStartSec`), y al cortarlo mata el grupo de procesos entero; el reloj
 * de aquí es solo por si systemd no contestara.
 */
function conductorSystemd({ unidad = 'acostaresearch-r', limiteSegundos }) {
  return ({ sesion }) =>
    new Promise((resolve) => {
      execFile(
        'systemctl',
        ['start', '--no-ask-password', '--quiet', `${unidad}@${sesion}.service`],
        { timeout: (limiteSegundos + 30) * 1000, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } },
        (error, _stdout, stderr) =>
          resolve({ fallo: error ? String(error.code ?? 'error') : null, stderr: String(stderr ?? '') }),
      );
    });
}

/**
 * En desarrollo: Rscript directamente, con un entorno vacío.
 *
 * Vacío y no el del proceso: el del proceso lleva la base de datos y las claves
 * de pago, y pasárselo a R es exactamente lo que la jaula del servidor impide.
 * Lo único que se copia es lo que Windows necesita para arrancar un programa.
 *
 * El reloj es propio y no el `timeout` de execFile porque en Windows Rscript
 * lanza R como otro proceso: matar solo a Rscript dejaba vivo a R, con la
 * consola abierta y bloqueada. Se mata el árbol entero.
 */
function conductorLocal({ rscript, runner, limiteSegundos }) {
  return ({ carpeta }) =>
    new Promise((resolve) => {
      const entorno = { LANG: 'C.UTF-8', HOME: carpeta, TMPDIR: carpeta };
      for (const clave of ['SystemRoot', 'windir', 'TEMP', 'TMP']) {
        if (process.env[clave]) entorno[clave] = process.env[clave];
      }
      if (process.platform !== 'win32') entorno.PATH = '/usr/local/bin:/usr/bin:/bin';

      let reloj = null;
      const hijo = execFile(
        rscript,
        ['--vanilla', runner],
        { cwd: carpeta, env: entorno, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, _stdout, stderr) => {
          clearTimeout(reloj);
          resolve({
            fallo: error ? String(error.code ?? 'error') : null,
            stderr: error?.code === 'ENOENT' ? `not found: ${rscript}` : String(stderr ?? ''),
          });
        },
      );

      reloj = setTimeout(() => {
        if (process.platform === 'win32' && hijo.pid) {
          execFile('taskkill', ['/pid', String(hijo.pid), '/T', '/F'], { windowsHide: true }, () => {});
        } else {
          hijo.kill('SIGKILL');
        }
      }, limiteSegundos * 1000);
    });
}

// ── El motor ────────────────────────────────────────────────────────────────

/**
 * @param {object} opciones
 * @param {string} opciones.carpetaBase   donde viven las carpetas de sesión
 * @param {Function} opciones.conductor   ({ sesion, carpeta }) => Promise<{ fallo, stderr }>
 * @param {number} [opciones.limiteSegundos]  el mismo que `TimeoutStartSec` de la unidad
 * @param {number} [opciones.maxSimultaneas]  procesos de R a la vez en todo el servidor
 * @param {number} [opciones.esperaMaximaMs]  cuánto se espera una plaza antes de rendirse
 */
function crearMotor({
  carpetaBase,
  conductor,
  limiteSegundos = 45,
  maxSimultaneas = 4,
  esperaMaximaMs = 20_000,
}) {
  // ── Una orden detrás de otra en cada sesión ──
  // Dos órdenes a la vez sobre la misma carpeta se pisarían `orden.R` y
  // `entorno.RData`, y la segunda recuperaría la sesión a medio guardar.
  const colas = new Map();

  function enSuTurno(sesion, trabajo) {
    const anterior = colas.get(sesion) ?? Promise.resolve();
    const actual = anterior.catch(() => {}).then(trabajo);
    const siguiente = actual.catch(() => {});
    colas.set(sesion, siguiente);
    siguiente.then(() => {
      if (colas.get(sesion) === siguiente) colas.delete(sesion);
    });
    return actual;
  }

  // ── Y un máximo de procesos en todo el servidor ──
  // La jaula pone tope a cada R y a todos juntos (el slice), pero sin esto el
  // que llega el quinto se encontraría con un R muerto por memoria en vez de
  // con unos segundos de espera.
  let enMarcha = 0;
  const esperando = [];

  function pedirPlaza() {
    if (enMarcha < maxSimultaneas) {
      enMarcha += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const turno = { resolve };
      turno.reloj = setTimeout(() => {
        const i = esperando.indexOf(turno);
        if (i !== -1) esperando.splice(i, 1);
        reject(new MotorOcupado('Todas las sesiones de R están ocupadas.'));
      }, esperaMaximaMs);
      esperando.push(turno);
    });
  }

  function soltarPlaza() {
    const siguiente = esperando.shift();
    if (siguiente) {
      clearTimeout(siguiente.reloj);
      siguiente.resolve();
    } else {
      enMarcha -= 1;
    }
  }

  /**
   * El grupo que comparten el backend y R: el de la carpeta de sesiones, que
   * pone infra/r/instalar.sh. Se mira una vez. En desarrollo es el del propio
   * usuario y ponerlo no cambia nada.
   */
  let gid;
  async function grupo() {
    if (gid === undefined) {
      try {
        gid = (await fs.stat(carpetaBase)).gid;
      } catch {
        gid = null;
      }
    }
    return gid;
  }

  function carpetaDe(sesion) {
    if (!SESION_SEGURA.test(String(sesion))) throw new Error('Identificador de sesión no válido');
    return path.join(carpetaBase, sesion);
  }

  /**
   * La carpeta de la sesión, creada si hace falta.
   *
   * Sin permiso para crearla es que la instalación del servidor no está hecha
   * (infra/r/instalar.sh): eso es «no disponible», no un fallo del código. El
   * código del error va en el mensaje, para que quien lo arregle sepa cuál.
   */
  async function prepararCarpeta(sesion) {
    const carpeta = carpetaDe(sesion);
    try {
      await fs.mkdir(carpetaBase, { recursive: true });
      await asegurarCarpeta(carpeta, await grupo());
    } catch (error) {
      if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) {
        throw new MotorNoDisponible(`Sin permiso sobre ${carpetaBase}: ${error.code} en ${error.syscall ?? '?'}`);
      }
      throw error;
    }
    return carpeta;
  }

  /** Ejecuta el código tal cual. Solo se llama dentro del turno de la sesión. */
  async function correr(sesion, codigo) {
    const carpeta = await prepararCarpeta(sesion);
    const g = await grupo();
    const graficos = path.join(carpeta, 'graficos');
    await asegurarCarpeta(graficos, g);
    await vaciar(graficos);
    await Promise.all(['fin', 'salida.txt', 'estado.tsv'].map((n) => fs.rm(path.join(carpeta, n), BORRAR)));
    await escribirSeguro(carpeta, 'orden.R', codigo, g);

    await pedirPlaza();
    const inicio = Date.now();
    let resultado;
    try {
      resultado = await conductor({ sesion, carpeta });
    } finally {
      soltarPlaza();
    }
    const segundos = (Date.now() - inicio) / 1000;

    const fin = await leerTexto(path.join(carpeta, 'fin'), 64);
    let estadoFinal;
    if (fin !== null) {
      estadoFinal = fin.trim() === 'ok' ? 'ok' : 'error';
    } else if (resultado.fallo && NO_DISPONIBLE.test(resultado.stderr)) {
      throw new MotorNoDisponible(resultado.stderr.trim().slice(0, 300));
    } else {
      // Sin `fin`, R no llegó al final: lo cortó el reloj o se quedó sin memoria.
      estadoFinal = segundos >= limiteSegundos - 1 ? 'tiempo' : 'cortado';
    }

    const salida = await leerSeguro(path.join(carpeta, 'salida.txt'), MAXIMO_SALIDA);
    const estado = parsearEstado(await leerTexto(path.join(carpeta, 'estado.tsv'), MAXIMO_ESTADO));
    const { imagenes, total } = await leerGraficos(graficos);

    return {
      resultado: estadoFinal,
      salida: salida ? salida.bytes.toString('utf8') : '',
      salidaTruncada: Boolean(salida?.truncado),
      estado,
      graficos: imagenes,
      totalGraficos: total,
      archivos: await listarArchivos(carpeta),
      segundos,
    };
  }

  /** Suma lo ejecutado al guion y la consola de la sesión, y los devuelve. */
  async function anotar(carpeta, { codigo, salida, conGuion }) {
    const guionPrevio = (await leerTexto(path.join(carpeta, 'guion.R'), MAXIMO_ACUMULADO * 2)) ?? CABECERA_GUION;
    const consolaPrevia = (await leerTexto(path.join(carpeta, 'consola.txt'), MAXIMO_ACUMULADO * 2)) ?? '';

    // Al guion solo va lo que corrió sin error: es lo que alguien tiene que
    // poder repetir en RStudio de principio a fin.
    const guion = conGuion ? cola(`${guionPrevio.replace(/\n*$/, '\n\n')}${codigo.trim()}\n`) : guionPrevio;
    const consola = cola(consolaPrevia ? `${consolaPrevia.replace(/\n*$/, '\n')}${salida}` : salida);

    const g = await grupo();
    await escribirSeguro(carpeta, 'guion.R', guion, g);
    await escribirSeguro(carpeta, 'consola.txt', consola, g);
    return { guion, consola };
  }

  async function borrarSesionSinTurno(carpeta) {
    await Promise.all(
      ['entorno.RData', 'paquetes.txt', 'guion.R', 'consola.txt', 'estado.tsv', 'salida.txt', 'fin'].map((n) =>
        fs.rm(path.join(carpeta, n), BORRAR),
      ),
    );
    await vaciar(path.join(carpeta, 'graficos'));
  }

  return {
    limiteSegundos,

    /**
     * ¿Se puede trabajar? Falso mientras la carpeta de sesiones no exista con
     * permisos para el backend: antes de instalar, o si alguien la rompe. Sin
     * esto, la herramienta daría un enlace de subida que luego fallaría.
     */
    async listo() {
      try {
        await fs.mkdir(carpetaBase, { recursive: true });
        await fs.access(carpetaBase, fsSync.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },

    /** Ejecuta una orden y la suma al guion. */
    ejecutar(sesion, codigo) {
      return enSuTurno(sesion, async () => {
        const hecho = await correr(sesion, codigo);
        const carpeta = carpetaDe(sesion);
        const acumulado = await anotar(carpeta, {
          codigo,
          salida: hecho.salida,
          conGuion: hecho.resultado === 'ok',
        });
        return { ...hecho, ...acumulado };
      });
    },

    /**
     * Mete el archivo del tesista y lo lee. Empieza una sesión nueva: los
     * objetos de otros datos no valen para estos.
     */
    subirDatos(sesion, { archivo, contenido, lectura }) {
      return enSuTurno(sesion, async () => {
        const carpeta = await prepararCarpeta(sesion);
        const g = await grupo();
        await borrarSesionSinTurno(carpeta);
        await Promise.all(
          ['datos.csv', 'datos.xlsx', 'datos.xls', 'datos.sav'].map((n) => fs.rm(path.join(carpeta, n), BORRAR)),
        );
        await escribirSeguro(carpeta, archivo, contenido, g);
        await escribirSeguro(carpeta, 'lectura.R', lectura, g);

        const hecho = await correr(sesion, `${lectura}\ndim(datos)\nnames(datos)`);
        const acumulado = await anotar(carpeta, {
          codigo: lectura,
          salida: hecho.salida,
          conGuion: hecho.resultado === 'ok',
        });
        return { ...hecho, ...acumulado };
      });
    },

    /** Borra los objetos y el guion, y vuelve a leer los datos si los hay. */
    reiniciar(sesion) {
      return enSuTurno(sesion, async () => {
        const carpeta = await prepararCarpeta(sesion);
        await borrarSesionSinTurno(carpeta);

        const lectura = await leerTexto(path.join(carpeta, 'lectura.R'), 4096);
        if (!lectura) return null;

        const hecho = await correr(sesion, lectura);
        const acumulado = await anotar(carpeta, {
          codigo: lectura,
          salida: hecho.salida,
          conGuion: hecho.resultado === 'ok',
        });
        return { ...hecho, ...acumulado };
      });
    },

    /** Lo que hay en la sesión, sin ejecutar nada. */
    async estado(sesion) {
      const carpeta = carpetaDe(sesion);
      const hayDatos = (await leerTexto(path.join(carpeta, 'lectura.R'), 4096)) !== null;
      const estado = parsearEstado(await leerTexto(path.join(carpeta, 'estado.tsv'), MAXIMO_ESTADO));
      return { hayDatos, ...estado, archivos: await listarArchivos(carpeta) };
    },

    /** Un archivo de la sesión para bajarlo, o null. Solo de la raíz o de graficos/. */
    async leerArchivo(sesion, nombre) {
      const partes = String(nombre).split('/');
      const valido =
        (partes.length === 1 && ARCHIVO_SEGURO.test(partes[0]) && !INTERNOS.has(partes[0])) ||
        (partes.length === 2 && partes[0] === 'graficos' && GRAFICO.test(partes[1]));
      if (!valido) return null;

      const carpeta = carpetaDe(sesion);
      if (partes.length === 2) {
        const info = await fs.lstat(path.join(carpeta, 'graficos')).catch(() => null);
        if (!info?.isDirectory()) return null;
      }

      const leido = await leerSeguro(path.join(carpeta, ...partes), MAXIMO_DESCARGA);
      return leido && !leido.truncado ? leido.bytes : null;
    },

    /** Todo lo de la sesión: cuando se borra el proyecto. */
    borrar(sesion) {
      return enSuTurno(sesion, () => fs.rm(carpetaDe(sesion), { ...BORRAR, recursive: true }));
    },
  };
}

module.exports = {
  crearMotor,
  conductorSystemd,
  conductorLocal,
  parsearEstado,
  leerSeguro,
  escribirSeguro,
  MotorNoDisponible,
  MotorOcupado,
  CABECERA_GUION,
};

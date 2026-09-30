'use strict';

/**
 * Los errores del backend, al móvil del administrador.
 *
 * Hasta el 30-sep los errores se descubrían porque un cliente escribía. Esto
 * mira cada línea de log de nivel `error` o `fatal` (los 5xx, los fallos de un
 * proceso programado, una pasarela que no responde) y avisa por ntfy:
 *
 *  · el primer error avisa al momento;
 *  · los siguientes se juntan y salen en UN aviso cada 15 minutos, con cuántas
 *    veces pasó cada uno. Una base caída escribe cientos de líneas por minuto
 *    y no puede convertirse en cientos de notificaciones;
 *  · a las 8:00 de Lima llega el resumen del día, también cuando no hubo nada:
 *    si un día no llega, el que no funciona es el vigilante.
 *
 * Solo viaja el mensaje del log (el texto fijo que escribe el código, como
 * «La pasarela rechazó el cobro»), nunca el objeto con los datos: en ntfy
 * gratuito cualquiera que acierte el tópico puede leerlo (ver `notify`).
 *
 * No depende del logger ni de `notify` directamente, para que el logger pueda
 * usarlo sin que se requieran en círculo: quien lo crea le pasa `avisar`.
 */

const VENTANA_MS = 15 * 60 * 1000;
const HORA_DEL_RESUMEN = 8;
const COMPROBAR_RESUMEN_MS = 10 * 60 * 1000;
const MAXIMO_EN_UN_AVISO = 6;

/** Mensajes que no se cuentan: los del propio aviso, que harían un bucle. */
const IGNORADOS = [/servidor de avisos/i, /no se pudo avisar/i];

/** Hora y fecha en Lima, que es la del administrador. */
function enLima(ms) {
  const partes = new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(partes.map((x) => [x.type, x.value]));
  return { dia: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour), hhmm: `${p.hour}:${p.minute}` };
}

/** «3× La pasarela rechazó el cobro» por línea, de más a menos. */
function listado(cuentas) {
  const orden = [...cuentas].sort((a, b) => b[1] - a[1]);
  const lineas = orden.slice(0, MAXIMO_EN_UN_AVISO).map(([msg, n]) => `${n}× ${msg}`);
  if (orden.length > MAXIMO_EN_UN_AVISO) lineas.push(`… y ${orden.length - MAXIMO_EN_UN_AVISO} distintos más`);
  return lineas.join('\n');
}

const total = (cuentas) => [...cuentas.values()].reduce((a, b) => a + b, 0);

function crearVigiaDeErrores({ avisar, ahora = () => Date.now(), ventanaMs = VENTANA_MS }) {
  const arranque = ahora();
  let pendientes = new Map();
  let delDia = new Map();
  let desdeDelDia = arranque;
  let ultimoAviso = -Infinity;
  let temporizador = null;
  let ultimoResumen = null;

  function vaciar() {
    temporizador = null;
    if (pendientes.size === 0) return;
    const n = total(pendientes);
    const cuentas = pendientes;
    pendientes = new Map();
    ultimoAviso = ahora();
    avisar({
      titulo: n === 1 ? 'Error en el backend' : `${n} errores en el backend`,
      mensaje: `${listado(cuentas)}\n\nDetalle: journalctl -u acostaresearch --since "-20 min" -p err`,
      etiquetas: ['rotating_light'],
      prioridad: 4,
    });
  }

  /** Una línea de log de nivel error o fatal. */
  function registrar(mensaje) {
    const msg = String(mensaje ?? '').trim().slice(0, 140) || '(error sin mensaje)';
    if (IGNORADOS.some((re) => re.test(msg))) return;
    pendientes.set(msg, (pendientes.get(msg) ?? 0) + 1);
    delDia.set(msg, (delDia.get(msg) ?? 0) + 1);

    const espera = ultimoAviso + ventanaMs - ahora();
    if (espera <= 0) {
      vaciar();
    } else if (!temporizador) {
      temporizador = setTimeout(vaciar, espera);
      temporizador.unref?.();
    }
  }

  /** Si ya son las 8 en Lima y hoy no salió, manda el resumen. */
  function quizaResumen() {
    const lima = enLima(ahora());
    if (lima.hora < HORA_DEL_RESUMEN || ultimoResumen === lima.dia) return false;
    ultimoResumen = lima.dia;
    const n = total(delDia);
    const desde = enLima(desdeDelDia);
    avisar({
      titulo: n === 0 ? 'Backend: sin errores' : `Backend: ${n} errores`,
      mensaje:
        (n === 0 ? 'Ningún error' : listado(delDia)) +
        `\n\nDesde el ${desde.dia} a las ${desde.hhmm}` +
        (desdeDelDia === arranque ? ' (arranque del servicio)' : '') +
        '. Si un día no llega este resumen, revisa el servidor.',
      etiquetas: [n === 0 ? 'white_check_mark' : 'bar_chart'],
      prioridad: n === 0 ? 2 : 3,
    });
    delDia = new Map();
    desdeDelDia = ahora();
    return true;
  }

  function vigilarResumen() {
    const reloj = setInterval(quizaResumen, COMPROBAR_RESUMEN_MS);
    reloj.unref?.();
    return reloj;
  }

  // El día que arranca no cuenta como «resumen pendiente» si arrancó después
  // de las 8: el primero sale mañana y cubre desde el arranque.
  if (enLima(arranque).hora >= HORA_DEL_RESUMEN) ultimoResumen = enLima(arranque).dia;

  return { registrar, vaciar, quizaResumen, vigilarResumen };
}

/** El texto de una llamada al logger: `log('msg')` o `log({ ... }, 'msg')`. */
function mensajeDeLlamada(args) {
  const texto = args.find((a) => typeof a === 'string');
  if (texto) return texto;
  const obj = args[0];
  return obj?.err?.message ?? obj?.message ?? null;
}

module.exports = { crearVigiaDeErrores, mensajeDeLlamada, enLima };

'use strict';

/**
 * Las subidas de archivos que se rechazan: qué se le dice al tesista y el
 * aviso al administrador.
 *
 * POR QUÉ
 * -------
 * El 6-oct-2026 un tesista quiso subir 80 PDF de laboratorio al enlace de R,
 * que entonces solo aceptaba Excel, CSV o SPSS. Nadie se enteró hasta que lo
 * contó. Cada rechazo es una señal de algo que la gente intenta hacer y el
 * sistema no deja; con este aviso llega al móvil el mismo día, con el tipo de
 * archivo, en vez de esperar a la queja.
 *
 * Y al tesista se le dice claro qué subió y qué se acepta ahí: «Eso es un
 * documento de Pages y aquí no lo aceptamos. Aquí se sube un Word (.docx)», con
 * cómo convertirlo cuando se puede. Antes, según la página, veía «Ocurrió un
 * error inesperado» (un archivo que pesaba de más) o un mensaje que no decía
 * qué había mal.
 *
 * Lo llama el manejador de errores (`middlewares/errorHandler`) para toda
 * respuesta 4xx a una petición que traía un archivo: así ninguna ruta tiene que
 * acordarse de avisar.
 */

const { avisarAlAdmin } = require('./notify');
const { tipoDeArchivo } = require('./tipoDeArchivo');

const ACEPTADOS_TEXTO = {
  pdf: 'PDF',
  docx: 'Word (.docx)',
  xlsx: 'Excel (.xlsx)',
  ole: 'Excel antiguo (.xls)',
  texto: 'CSV o texto',
  sav: 'SPSS (.sav)',
  zip: '.zip con PDF',
  imagen: 'imagen (PNG, JPG o WEBP)',
};

/**
 * Cada subida que ve un tesista o un comprador: cómo se llama en el aviso y qué
 * acepta. Las del panel de administración no están: quien sube ahí es el
 * administrador, y un aviso por sus propios intentos no le dice nada.
 */
const SUBIDAS = [
  { ruta: /\/r\/subir\//, nombre: 'Datos para el análisis en R', acepta: ['xlsx', 'ole', 'texto', 'sav', 'pdf', 'zip'] },
  { ruta: /\/proyectos\/formato\//, nombre: 'Formato de la universidad', acepta: ['docx'] },
  { ruta: /\/proyectos\/material\//, nombre: 'Material del curso', acepta: ['docx', 'pdf', 'xlsx', 'texto'] },
  { ruta: /\/proyectos\/documento-enlace\//, nombre: 'Documento de la tesis (enlace del chat)', acepta: ['docx', 'pdf'] },
  { ruta: /\/proyectos\/[^/]+\/avance$/, nombre: 'Avance de tesis (panel)', acepta: ['docx'] },
  { ruta: /\/proyectos\/[^/]+\/documento$/, nombre: 'Documento de la tesis (panel)', acepta: ['docx'] },
  { ruta: /\/proyectos\/[^/]+\/plantilla$/, nombre: 'Plantilla de la universidad (panel)', acepta: ['docx'] },
  { ruta: /\/cualitativo\/entrevistas\//, nombre: 'Entrevistas', acepta: ['docx', 'pdf', 'texto'] },
  { ruta: /\/preparar\/[^/]+$/, nombre: 'Preparar documento', acepta: ['docx'] },
  { ruta: /\/pedidos\//, nombre: 'Revisión con asesor', acepta: ['docx'] },
  { ruta: /\/mis-fuentes/, nombre: 'Importar fuentes', acepta: ['texto', 'pdf'] },
  { ruta: /\/payments\/manual/, nombre: 'Comprobante de pago', acepta: ['imagen'] },
];

/** Cada cuánto, como mucho, se avisa del mismo rechazo (misma subida, mismo tipo). */
const VENTANA_MS = 30 * 60 * 1000;
const recientes = new Map();

const megas = (bytes) => `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

function subidaDe(ruta) {
  return SUBIDAS.find((s) => s.ruta.test(ruta)) ?? null;
}

/** «Word (.docx)», «PDF o Word (.docx)», «Excel (.xlsx), CSV o texto y PDF»… */
function listaDe(claves) {
  const textos = [...new Set(claves.map((c) => ACEPTADOS_TEXTO[c]).filter(Boolean))];
  if (textos.length <= 1) return textos[0] ?? '';
  return `${textos.slice(0, -1).join(', ')} o ${textos.at(-1)}`;
}

/**
 * El mensaje para el tesista cuando lo que subió no es de lo que se acepta
 * ahí, o null si sí lo es (entonces vale el mensaje de la ruta, que sabe qué
 * tiene de malo por dentro).
 */
function mensajeParaElUsuario(subida, tipo, { demasiadoGrande, limite } = {}) {
  if (demasiadoGrande) {
    return (
      `El archivo pesa demasiado${limite ? `: aquí el máximo es ${megas(limite)}` : ''}. ` +
      'Comprueba que sea el archivo correcto o pregunta en tu conversación cómo seguir.'
    );
  }
  if (!subida || !tipo || subida.acepta.includes(tipo.clave)) return null;
  return (
    `Eso es ${tipo.nombre} y aquí no lo aceptamos. Aquí se sube: ${listaDe(subida.acepta)}.` +
    (tipo.pista ? ` ${tipo.pista}` : '')
  );
}

/** El aviso al móvil, agrupando los reintentos: quien no puede, prueba cinco veces. */
function avisar({ subida, ruta, tipo, bytes, mensaje, estado }) {
  const clave = `${subida?.nombre ?? ruta}|${tipo?.clave ?? '?'}`;
  const ahora = Date.now();
  const previo = recientes.get(clave);
  if (previo && ahora - previo.cuando < VENTANA_MS) {
    previo.callados += 1;
    return false;
  }
  recientes.set(clave, { cuando: ahora, callados: 0 });
  // Que el mapa no crezca sin fin con rutas raras.
  if (recientes.size > 500) recientes.delete(recientes.keys().next().value);

  const otros = previo?.callados ? ` (y ${previo.callados} más del mismo tipo desde el aviso anterior)` : '';
  // Sin correo ni nombre: el tópico de ntfy no es privado (ver lib/notify).
  avisarAlAdmin({
    titulo: `Subida rechazada · ${subida?.nombre ?? 'otra subida'}`,
    mensaje:
      `Intentaron subir ${tipo?.nombre ?? 'un archivo'}${bytes ? ` de ${megas(bytes)}` : ''}${otros}.\n` +
      `Se le dijo: «${String(mensaje).slice(0, 300)}»` +
      (subida ? '' : `\nRuta: ${ruta}`) +
      `\nCódigo ${estado}.`,
    etiquetas: ['outbox_tray'],
    prioridad: 3,
  });
  return true;
}

/**
 * ¿Es una subida rechazada? Si lo es, avisa y devuelve el mensaje que hay que
 * darle al usuario en lugar del de la ruta (o null para dejar el de la ruta).
 * Si no lo es, devuelve undefined y no hace nada.
 */
function revisarRechazo(req, { estado, mensaje, error }) {
  if (estado < 400 || estado >= 500 || estado === 401 || estado === 403 || estado === 404) return undefined;
  if (!['POST', 'PUT'].includes(req.method)) return undefined;
  if (req.user?.role === 'ADMIN') return undefined;

  const demasiadoGrande = error?.type === 'entity.too.large';
  const conBytes = Buffer.isBuffer(req.body) && req.body.length > 0;
  // El cuerpo no se leyó cuando el tipo no encajaba con el de la ruta o pesaba
  // de más; entonces solo queda lo que dice la cabecera.
  const cabeceras = req.headers ?? {};
  const declarado = Number(cabeceras['content-length']) || 0;
  const formulario = /json|urlencoded/i.test(String(cabeceras['content-type'] ?? ''));
  const traiaArchivo = conBytes || demasiadoGrande || (declarado > 0 && !formulario);
  if (!traiaArchivo) return undefined;

  const ruta = String(req.originalUrl ?? '').split('?')[0];
  const subida = subidaDe(ruta);
  // Una ruta con cuerpo en bruto que no es una subida de la lista (un webhook)
  // no avisa: no hay a quién decirle qué se acepta.
  if (!subida && !demasiadoGrande) return undefined;

  const tipo = tipoDeArchivo(conBytes ? req.body : null, cabeceras['content-type']);
  const propio = mensajeParaElUsuario(subida, tipo, { demasiadoGrande, limite: error?.limit });

  avisar({
    subida,
    ruta: ruta.replace(/[A-Za-z0-9_-]{24,}/g, ':token'),
    tipo,
    bytes: conBytes ? req.body.length : declarado,
    mensaje: propio ?? mensaje,
    estado,
  });
  return propio;
}

/** Solo para las pruebas. */
function olvidarAvisos() {
  recientes.clear();
}

module.exports = { revisarRechazo, mensajeParaElUsuario, subidaDe, listaDe, olvidarAvisos, SUBIDAS };

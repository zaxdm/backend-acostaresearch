'use strict';

/**
 * «Preparar documento»: el recorrido completo.
 *
 * QUÉ ES
 * ------
 * Tres servicios sobre el Word que sube el cliente:
 *   · EDICION    — corrige el inglés académico y lo devuelve CON CONTROL DE
 *                  CAMBIOS, para que él acepte o rechace cada corrección.
 *   · TRADUCCION — lo traduce a español, inglés, portugués o chino.
 *   · RESUMEN    — escribe el resumen, el abstract y las palabras clave, en un
 *                  documento aparte.
 *
 * Los tres devuelven un .docx. En los dos primeros es SU documento: sus tablas,
 * sus figuras, su bibliografía, su portada y su formato, con solo los párrafos
 * del cuerpo tocados. Eso lo hace posible `project.documento` y
 * `project.reescritura`, que ya sabían hacerlo para el conector.
 *
 * SIN HUMANO EN MEDIO
 * -------------------
 * El cliente sube, el servidor trabaja y el cliente descarga. No hay revisión
 * nuestra, y por eso el aviso de que lo hace una IA y de que hay que revisarlo
 * está en la web, en el correo y dentro del propio documento de resúmenes.
 *
 * CÓMO SE COBRA
 * -------------
 * Por membresía, no por documento: hasta diez documentos al mes mientras esté
 * vigente, del tamaño que sea y en cualquiera de los tres servicios. El cupo lo
 * lleva `preparar.membresia`, contando las preparaciones de la ventana en
 * curso. Lo que falla no gasta cupo.
 *
 * POR QUÉ EL TRABAJO NO ESPERA A LA PETICIÓN
 * ------------------------------------------
 * Un documento de 25.000 palabras son unas treinta llamadas al modelo: varios
 * minutos. Ninguna petición HTTP aguanta eso —ni el navegador, ni el proxy—, y
 * dejarla abierta significaría que recargar la página pierde el trabajo ya
 * pagado. Así que la petición devuelve el encargo y el trabajo sigue en el
 * servidor; la web pregunta cómo va y, cuando está, se descarga. Es lo mismo
 * que hace el análisis cualitativo.
 */

const env = require('../../config/env');
const logger = require('../../config/logger');
const { ERROR_CODES } = require('../../config/constants');
const { AppError, NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const { enSerie } = require('../../shared/utils/enSerie');
const { sendMail } = require('../../lib/mailer');
const plantillas = require('../../lib/emailTemplates');

const documento = require('../projects/project.documento');

const repository = require('./preparar.repository');
const membresia = require('./preparar.membresia');
const almacen = require('./preparar.storage');
const cuerpo = require('./preparar.cuerpo');
const motor = require('./preparar.motor');
const cambios = require('./preparar.cambios');
const traduccion = require('./preparar.traduccion');
const resumenDocx = require('./preparar.resumen');
const { IDIOMAS } = require('./preparar.prompt');

/** Nombre de cada servicio, tal y como se le dice al cliente. */
const NOMBRES = Object.freeze({
  EDICION: 'Edición de inglés académico',
  TRADUCCION: 'Traducción',
  RESUMEN: 'Resumen, abstract y palabras clave',
});

/**
 * Qué se le dice cuando no se pudo cambiar ni un párrafo.
 *
 * Pasa cuando el documento entero está dentro de tablas o cuadros de texto, o
 * cuando lo que subió ya estaba hecho. No se entrega: un documento idéntico al
 * que subió, cobrado, es lo mismo que no haber hecho nada.
 */
const SIN_TOCAR = Object.freeze({
  EDICION:
    'No hemos cambiado ni un párrafo, así que no te hemos descontado ningún documento de tu ' +
    'membresía. Suele pasar cuando el texto ya está en inglés correcto, o cuando el trabajo está ' +
    'dentro de tablas o cuadros de texto, que este servicio no toca.',
  TRADUCCION:
    'No hemos podido traducir ni un párrafo, así que no te hemos descontado ningún documento de ' +
    'tu membresía. Suele pasar cuando el documento ya está en ese idioma, o cuando el texto está ' +
    'dentro de tablas o cuadros de texto, que este servicio no toca.',
});

/**
 * Cuánto puede llevar un trabajo antes de darlo por colgado.
 *
 * Un documento grande con las tandas en serie puede irse a diez minutos largos.
 * Treinta es holgado y sigue siendo mucho menos que «para siempre», que es lo
 * que duraría un EN_CURSO si el proceso se reinicia a mitad. Ver `rescatar`.
 */
const COLGADA_MS = 30 * 60_000;

/** Todos los trabajos van de uno en uno en este proceso. Ver `trabajar`. */
const COLA = 'preparar:documentos';

const servicioNoDisponible = () =>
  new AppError('«Preparar documento» no está disponible ahora mismo.', {
    statusCode: 503,
    code: ERROR_CODES.PREPARAR_UNAVAILABLE,
  });

// ── El cupo ────────────────────────────────────────────────────────────────

/**
 * La membresía del cliente y cuántos documentos le quedan este mes.
 *
 * Devuelve siempre algo: sin membresía, `{ pack: null, cupo: null }` con el
 * motivo. La web lo usa para decidir si enseña el formulario de subida o la
 * tarjeta de compra, así que tiene que poder preguntarlo sin haber comprado.
 */
async function cupoDe(userId, ahora = new Date()) {
  const pack = await repository.membresiaDe(userId);
  if (!pack) return { pack: null, cupo: null, motivo: membresia.porQueNo(null, 0, ahora) };

  const ventana = membresia.ventanaDe(pack, ahora);
  const usados = await repository.usadosEn(pack.id, ventana.desde, ventana.hasta);

  return {
    pack,
    cupo: membresia.cupoDe(pack, usados, ahora),
    motivo: membresia.porQueNo(pack, usados, ahora),
  };
}

// ── Recoger el documento ───────────────────────────────────────────────────

/** El idioma pedido, comprobado. Solo en traducción. */
function idiomaDe(servicio, idioma) {
  if (servicio !== 'TRADUCCION') return null;
  if (!IDIOMAS[idioma]) {
    throw new ValidationError('Elige a qué idioma quieres traducirlo: español, inglés, portugués o chino.');
  }
  return idioma;
}

/**
 * Lee el .docx y saca su cuerpo, traduciendo los fallos a frases del cliente.
 *
 * `documento.abrir` ya escribe mensajes que se le pueden enseñar tal cual —«eso
 * es un .doc antiguo, guárdalo como .docx»—, así que se dejan pasar como están.
 */
function cuerpoDelArchivo(buffer) {
  let leido;
  try {
    leido = cuerpo.cuerpoDe(buffer);
  } catch (error) {
    if (error instanceof documento.DocumentoNoValido) throw new ValidationError(error.message);
    throw error;
  }

  if (leido.parrafos.length === 0) {
    throw new ValidationError(
      'No encontramos texto que preparar en ese documento. Si tu trabajo está dentro de ' +
        'tablas o cuadros de texto, este servicio no los toca: sube la versión en párrafos.',
    );
  }

  if (leido.palabras > env.PREPARAR_MAX_PALABRAS) {
    throw new ValidationError(
      `Ese documento tiene ${leido.palabras.toLocaleString('es-PE')} palabras y el tope es ` +
        `${env.PREPARAR_MAX_PALABRAS.toLocaleString('es-PE')}. Pártelo en dos y mándalos por ` +
        'separado: cuentan como dos documentos de tu membresía.',
    );
  }

  return leido;
}

// ── Hacer el trabajo ───────────────────────────────────────────────────────

/** El .docx terminado, según el servicio. */
async function producir({ preparacion, buffer, parrafos }) {
  if (preparacion.servicio === 'RESUMEN') {
    const resumen = await motor.resumenDe({ parrafos });
    return {
      buffer: await resumenDocx.armar({ ...resumen, nombre: preparacion.nombre }),
      tocados: 0,
      intactos: 0,
    };
  }

  const { cambios: propuestos, malos } = await motor.prepararParrafos({
    parrafos,
    servicio: preparacion.servicio,
    idioma: preparacion.idioma,
  });

  // EDICION, con control de cambios: es lo que distingue una corrección de
  // lengua de un texto cambiado por detrás. Ver `preparar.cambios`.
  //
  // TRADUCCION: el texto nuevo entra en el párrafo conservando su formato, sin
  // marcas. Marcar una traducción entera como revisión no tiene sentido: no hay
  // nada que aceptar o rechazar palabra a palabra, el documento ES la traducción.
  const hecho =
    preparacion.servicio === 'EDICION'
      ? cambios.aplicar(buffer, propuestos)
      : traduccion.traducir(buffer, propuestos);

  // Cero párrafos tocados es devolverle su propio archivo. Sale por el camino
  // del fallo a propósito: así no le gasta un documento del mes y se le explica
  // qué pasó, en vez de dejarle descargar lo mismo que subió.
  if (hecho.tocados === 0) throw new Error(SIN_TOCAR[preparacion.servicio]);

  return { buffer: hecho.buffer, tocados: hecho.tocados, intactos: hecho.intactos.size + malos.length };
}

/**
 * Avisa al cliente de que su documento está listo (o de que no salió).
 *
 * Sin bloquear y sin propagar: para cuando esto corre, el trabajo ya está
 * cerrado en la base y el .docx en disco. Que el correo falle no puede
 * deshacerlo, y el cliente lo ve igual en la web. Mismo criterio que
 * `payments/payment.delivery`.
 */
function avisar(preparacion, usuario) {
  if (!usuario?.email) return;

  const mensaje =
    preparacion.estado === 'LISTO'
      ? plantillas.documentoPreparado({
          firstName: usuario.firstName,
          servicio: NOMBRES[preparacion.servicio],
          nombre: preparacion.nombre,
          idioma: preparacion.idioma ? IDIOMAS[preparacion.idioma].nombre : null,
          intactos: preparacion.intactos,
        })
      : plantillas.documentoFallido({
          firstName: usuario.firstName,
          servicio: NOMBRES[preparacion.servicio],
          nombre: preparacion.nombre,
          motivo: preparacion.error,
        });

  sendMail({ to: usuario.email, ...mensaje }).catch((error) => {
    logger.error(
      { err: error, preparacionId: preparacion.id },
      'No se pudo avisar al cliente de su documento preparado',
    );
  });
}

/**
 * Trabaja un encargo de principio a fin.
 *
 * DE UNO EN UNO, y no por prudencia sobrante: el VPS tiene dos vCPU y 3,7 GB, y
 * este mismo proceso atiende el conector de todos los tesistas y la web. Cada
 * trabajo ya lanza varias tandas en paralelo por su cuenta
 * (`PREPARAR_TANDAS_A_LA_VEZ`); permitir además cinco trabajos a la vez sería
 * quince peticiones simultáneas a Google y un servidor que no contesta a nadie
 * más. La cola hace esperar, que es lo correcto: el cliente ya sabe que esto
 * tarda minutos.
 *
 * No devuelve nada y no lanza: lo que puede fallar se apunta en la fila.
 */
function trabajar(preparacionId) {
  return enSerie(COLA, async () => {
    let preparacion;
    try {
      preparacion = await repository.marcar(preparacionId, { estado: 'EN_CURSO' });

      const buffer = await almacen.leerEntrada(preparacionId);
      const { parrafos } = cuerpo.cuerpoDe(buffer);

      const hecho = await producir({ preparacion, buffer, parrafos });
      await almacen.guardarSalida(preparacionId, hecho.buffer);

      preparacion = await repository.marcar(preparacionId, {
        estado: 'LISTO',
        entregadoAt: new Date(),
        tocados: hecho.tocados,
        intactos: hecho.intactos,
        error: null,
      });

      logger.info(
        {
          preparacionId,
          servicio: preparacion.servicio,
          palabras: preparacion.palabras,
          tocados: hecho.tocados,
          intactos: hecho.intactos,
        },
        'Preparar documento: entregado',
      );
    } catch (error) {
      logger.error({ err: error, preparacionId }, 'Preparar documento: el trabajo falló');
      preparacion = await repository
        .marcar(preparacionId, {
          estado: 'FALLIDO',
          // Se le enseña tal cual al cliente, así que se recorta a lo que cabe
          // en la columna y se acompaña de qué hacer.
          error: String(error.message ?? 'No se pudo preparar el documento.').slice(0, 400),
        })
        .catch(() => null);
    }

    if (!preparacion) return;
    const dueno = await repository.duenoDe(preparacionId).catch(() => null);
    avisar({ ...preparacion, id: preparacionId }, dueno?.user);
  });
}

/**
 * Da por fallidos los trabajos que se quedaron colgados.
 *
 * Un reinicio del servidor a mitad de un trabajo deja su fila en EN_CURSO para
 * siempre: nadie la va a terminar, porque la cola vive en memoria. Y mientras
 * esté ahí, sigue gastando cupo del mes.
 *
 * Se arregla al vuelo, cada vez que alguien mira su panel, en vez de con una
 * tarea programada: no hace falta un proceso más para algo que solo importa
 * cuando el dueño vuelve a mirar, y así no hay un reloj que mantener.
 */
async function rescatar(userId, ahora = new Date()) {
  const colgadas = await repository.listarDe(userId, { limite: 20 });
  const limite = new Date(ahora.getTime() - COLGADA_MS);

  const perdidas = colgadas.filter(
    (fila) => (fila.estado === 'EN_CURSO' || fila.estado === 'EN_COLA') && fila.createdAt < limite,
  );

  for (const perdida of perdidas) {
    await repository
      .marcar(perdida.id, {
        estado: 'FALLIDO',
        error:
          'El servidor se reinició mientras preparábamos tu documento. No te descontó ningún ' +
          'documento de tu membresía: vuelve a subirlo.',
      })
      .catch(() => null);
  }

  return perdidas.length;
}

/**
 * Recibe el documento y lo pone a preparar. Siempre desde `encargar`, que es
 * quien pone el turno: esto lee el cupo y escribe una fila, y hacer las dos
 * cosas a la vez dos veces es justo lo que deja pasar un documento de más.
 *
 * El orden importa: primero el cupo, después el archivo. Comprobar el archivo
 * de un cliente sin membresía es trabajo que no se le va a cobrar, y peor, le
 * diría «tu documento tiene 8.000 palabras» antes de decirle que no puede
 * mandarlo.
 */
async function recibirEncargo({ userId, servicio, idioma, buffer, nombre }, ahora = new Date()) {
  if (!env.prepararEnabled) throw servicioNoDisponible();

  const { pack, cupo, motivo } = await cupoDe(userId, ahora);
  if (motivo) {
    throw new AppError(motivo, {
      statusCode: 402,
      code: ERROR_CODES.NO_DOCUMENTOS,
      details: cupo ? { restantes: cupo.restantes, renuevaEl: cupo.renuevaEl } : null,
    });
  }

  const destino = idiomaDe(servicio, idioma);
  const leido = cuerpoDelArchivo(buffer);

  const preparacion = await repository.crear({
    userId,
    docPackId: pack.id,
    servicio,
    idioma: destino,
    nombre: String(nombre).slice(0, 255),
    palabras: leido.palabras,
    bytes: buffer.length,
    estado: 'EN_COLA',
  });

  await almacen.guardarEntrada(preparacion.id, buffer);

  logger.info(
    { userId, preparacionId: preparacion.id, servicio, idioma: destino, palabras: leido.palabras },
    'Preparar documento: encargo recibido',
  );

  // A propósito sin `await`: la petición contesta ya y el trabajo sigue. Ver
  // la nota de arriba sobre por qué no puede esperar.
  trabajar(preparacion.id);

  return {
    preparacion,
    cupo: { ...cupo, usados: cupo.usados + 1, restantes: Math.max(0, cupo.restantes - 1) },
  };
}

// ── Lo que usa la web ──────────────────────────────────────────────────────

const prepararService = {
  NOMBRES,
  IDIOMAS,

  /** Lo que la pantalla necesita para pintarse: membresía, cupo e historial. */
  async panel(userId, ahora = new Date()) {
    await rescatar(userId, ahora);
    const { pack, cupo, motivo } = await cupoDe(userId, ahora);

    return {
      disponible: env.prepararEnabled,
      membresia: pack
        ? {
            plan: pack.plan,
            estado: pack.status,
            activadaEl: pack.activatedAt,
            caducaEl: pack.expiresAt,
            vigente: membresia.vigente(pack, ahora),
          }
        : null,
      cupo,
      motivo,
      idiomas: Object.values(IDIOMAS).map(({ codigo, nombre }) => ({ codigo, nombre })),
      maxPalabras: env.PREPARAR_MAX_PALABRAS,
      trabajos: await repository.listarDe(userId),
    };
  },

  /** Recibe el documento y lo pone a preparar. Ver `recibirEncargo`. */
  encargar(peticion, ahora = new Date()) {
    // Los encargos de una misma persona, de uno en uno.
    //
    // El cupo no es una columna que se decremente: se cuenta mirando las
    // preparaciones de la ventana. Dos peticiones a la vez contaban las dos lo
    // de antes y las dos pasaban, así que con un documento de margen se podían
    // meter dos. De persona en persona y no global: esto es una comprobación y
    // una fila, no el trabajo pesado, y nadie tiene que esperar a otro.
    return enSerie(`preparar:encargo:${peticion.userId}`, () => recibirEncargo(peticion, ahora));
  },

  /** Cómo va un trabajo. Es lo que pregunta la web mientras espera. */
  async ver({ userId, id }) {
    const preparacion = await repository.mia(userId, id);
    if (!preparacion) throw new NotFoundError('Ese documento no existe o no es tuyo.');
    return preparacion;
  },

  /** El .docx terminado. */
  async descargar({ userId, id }) {
    const preparacion = await prepararService.ver({ userId, id });

    if (preparacion.estado !== 'LISTO' || !(await almacen.haySalida(id))) {
      throw new AppError('Ese documento todavía no está listo.', {
        statusCode: 409,
        code: ERROR_CODES.NOT_FOUND,
      });
    }

    return { preparacion, buffer: await almacen.leerSalida(id) };
  },

  /**
   * El nombre con el que se descarga.
   *
   * Lleva el del cliente para que lo reconozca entre veinte versiones, y un
   * sufijo que dice qué se le hizo: «tesis (traducido al inglés).docx». Sin el
   * sufijo, el archivo descargado se llama igual que el que subió y acaba
   * pisándolo en la carpeta de Descargas.
   */
  nombreDeDescarga(preparacion) {
    const base = String(preparacion.nombre).replace(/\.docx$/i, '').slice(0, 120);

    if (preparacion.servicio === 'RESUMEN') return `${base} (resumen y abstract).docx`;
    if (preparacion.servicio === 'EDICION') return `${base} (inglés corregido).docx`;
    return `${base} (traducido al ${IDIOMAS[preparacion.idioma]?.nombre ?? 'idioma elegido'}).docx`;
  },

  // ── La venta ─────────────────────────────────────────────────────────────

  /**
   * Qué hacer al cobrar una membresía: emitirla o alargar la que ya tiene.
   *
   * Gemelo de `licensing.prepareForPurchase` y por el mismo motivo: emitir una
   * segunda membresía al que renueva le dejaría dos, y el cupo se contaría
   * sobre una de las dos. Se alarga la que tiene, desde su caducidad si aún no
   * ha llegado —renovar con margen no puede costarle los días que le quedaban—
   * y desde hoy si ya pasó.
   *
   * `activatedAt` NO se mueve: es el origen de las ventanas de treinta días, y
   * moverlo al renovar el día 20 regalaría un mes de cupo cada renovación.
   */
  async prepararParaCompra({ userId, plan }, ahora = new Date()) {
    const dias = plan.durationDays > 0 ? plan.durationDays : 30;
    const vigente = await repository.packVigenteDe(userId);

    if (vigente) {
      const desde = vigente.expiresAt > ahora ? vigente.expiresAt : ahora;
      return {
        renovacion: {
          packId: vigente.id,
          expiresAt: new Date(desde.getTime() + dias * 24 * 60 * 60 * 1000),
          docsPorMes: plan.docsPorMes,
        },
      };
    }

    return {
      data: {
        userId,
        planId: plan.id,
        docsPorMes: plan.docsPorMes,
        activatedAt: ahora,
        expiresAt: new Date(ahora.getTime() + dias * 24 * 60 * 60 * 1000),
      },
    };
  },

  cupoDe,
  trabajar,
  rescatar,
};

module.exports = prepararService;

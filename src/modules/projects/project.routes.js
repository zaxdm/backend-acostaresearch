'use strict';

const { Router } = require('express');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const { ForbiddenError, NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const { ROLES } = require('../../config/constants');
const { mensajeEnlaceNoVale } = require('../../shared/utils/enlaceNoVale');
const licenseService = require('../licensing/license.service');
const { perfilDe } = require('../productos/producto.perfil');
const projectService = require('./project.service');
const {
  normaSchema,
  borrarProyectoSchema,
  nuevaTesisSchema,
  autorSchema,
  asesorSchema,
  retomarSchema,
} = require('./project.schema');
const descarga = require('./project.descarga');
const { PlantillaNoValida, MAXIMO_BYTES } = require('./project.plantilla');
const documentoService = require('./documento.service');
const {
  DocumentoNoValido,
  NormaConNotas,
  MAXIMO_BYTES: MAXIMO_DOCUMENTO,
} = require('./project.documento');

const subidaFormato = require('./project.subida-formato');

const TIPO_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const router = Router();

/**
 * El nombre del archivo que subió, para poder enseñárselo.
 *
 * Nunca se usa para escribir en disco —eso va por el identificador del
 * proyecto—, así que aquí no hay riesgo de ruta; lo único que importa es que un
 * nombre mal codificado no tumbe la subida de una plantilla que sí es válida.
 */
function decodificar(cabecera) {
  const bruto = String(cabecera ?? '').slice(0, 400);
  if (bruto === '') return null;

  try {
    return decodeURIComponent(bruto).slice(0, 200);
  } catch {
    return bruto.slice(0, 200);
  }
}

/**
 * El proyecto es de quien lo escribe.
 *
 * Todas las rutas trabajan sobre `req.user.id` y ninguna acepta de quién por
 * parámetro. Un identificador de usuario que viaje en la petición es la forma
 * más rápida de acabar enseñando la tesis de otro — y aquí, además de fuentes,
 * hay lo que alguien ha decidido sobre su propia investigación.
 */
/**
 * El Word desde el enlace que da el conector.
 *
 * Es la ÚNICA ruta de proyectos sin sesión, y por eso va antes del
 * `authenticate`. Lo que la protege es el propio enlace: firmado, con dueño y
 * proyecto dentro, y media hora de vida (ver `project.descarga`). Un enlace
 * vencido y uno alterado dicen cosas distintas (ver `enlaceNoVale`).
 */
router.get(
  '/descarga/:token',
  asyncHandler(async (req, res) => {
    let destino;
    try {
      destino = descarga.verificar(req.params.token);
    } catch (error) {
      return res
        .status(404)
        .type('text/plain; charset=utf-8')
        .send(
          `${mensajeEnlaceNoVale(error, { para: 'descargar', minutos: descarga.MINUTOS })} También ` +
            'puedes descargarlo desde tu perfil en acostaresearch.com.',
        );
    }

    /**
     * La licencia se vuelve a mirar AQUÍ, no solo al dar el enlace.
     *
     * El enlace dura media hora, y en esa media hora se puede revocar una
     * licencia por uso compartido. Sin esto, el Word seguía bajándose treinta
     * minutos después de cortarle el acceso.
     */
    if (!(await tieneLicenciaVigente(destino.userId, destino.productCode))) {
      return res
        .status(403)
        .type('text/plain; charset=utf-8')
        .send('Tu licencia de este método ya no está vigente, así que este enlace dejó de servir.');
    }

    // El Word que subió el tesista, con las citas que puso Claude.
    if (destino.que === 'documento') {
      let citado;
      try {
        citado = await documentoService.armar(destino.userId, destino.productCode);
      } catch (error) {
        if (!(error instanceof NormaConNotas)) throw error;
        return res.status(422).type('text/plain; charset=utf-8').send(error.message);
      }
      if (!citado) {
        return res
          .status(404)
          .type('text/plain; charset=utf-8')
          .send('Ya no hay ningún documento subido en esta tesis. Súbelo otra vez desde tu perfil.');
      }
      res.setHeader('Content-Type', TIPO_DOCX);
      res.setHeader('Content-Disposition', `attachment; filename="${citado.nombreArchivo}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      return res.send(citado.buffer);
    }

    const documento = await projectService.armarWord(destino.userId, destino.productCode);
    if (!documento) {
      return res
        .status(404)
        .type('text/plain; charset=utf-8')
        .send('Todavía no hay ningún capítulo escrito en esta tesis.');
    }

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${documento.nombreArchivo}"`);
    // Que el enlace no se quede en una caché ni viaje a otra página como origen.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.send(documento.buffer);
  }),
);

/**
 * El formato de la universidad, desde el enlace que da Claude.
 *
 * Sin sesión, como la subida de la matriz de R: la llave es el enlace firmado
 * (ver `project.subida-formato`), y quien viene de la conversación no tiene por
 * qué haber entrado en la web. Lo que se hace con el archivo es lo mismo que en
 * la subida del perfil: se queda el formato y se tira el contenido.
 */
/** Vencido o alterado: cada uno con su mensaje (ver `enlaceNoVale`). */
function enlaceDeFormato(token) {
  try {
    return subidaFormato.verificar(token);
  } catch (error) {
    throw new NotFoundError(
      mensajeEnlaceNoVale(error, { para: 'subir tu formato', minutos: subidaFormato.MINUTOS }),
    );
  }
}

/** Licencia vigente de ese método: el mismo criterio que el envío del análisis. */
async function tieneLicenciaVigente(userId, productCode) {
  const ahora = new Date();
  const licencias = await licenseService.listForUser(userId);
  return licencias.some(
    (l) =>
      l.productCode === productCode &&
      l.status === 'ACTIVE' &&
      (!l.expiresAt || new Date(l.expiresAt) > ahora),
  );
}

const cuerpoDeFormato = express.raw({ type: () => true, limit: MAXIMO_BYTES });

function recibirFormato(req, res, next) {
  cuerpoDeFormato(req, res, (error) => {
    if (error?.type === 'entity.too.large') {
      return next(
        new ValidationError(
          `Ese archivo pasa de ${MAXIMO_BYTES / 1024 / 1024} MB. Sube el documento de formato que ` +
            'te dio tu facultad, no tu tesis.',
        ),
      );
    }
    return next(error);
  });
}

// La página pregunta primero si el enlace vale y si ya hay un formato puesto.
router.get(
  '/formato/:token',
  asyncHandler(async (req, res) => {
    const enlace = enlaceDeFormato(req.params.token);
    const formato = await projectService.formatoDelProyecto(enlace.userId, enlace.productCode);
    // El tipo decide los textos de la página: un informe de curso no tiene «tesis».
    const { tipo } = perfilDe(enlace.productCode);
    // Y el ámbito: la plantilla de un informe de empresa no la da un docente.
    const ambito = (await projectService.esInformeDeEmpresa(enlace.userId, enlace.productCode)) ? 'empresa' : null;
    return ok(res, { caduca: enlace.caduca.toISOString(), formato, tipo, ambito });
  }),
);

/**
 * El enlace se comprueba ANTES de leer el archivo: si no, un token inventado
 * hacía que la API se tragara 5 MB en memoria antes de rechazarlo.
 */
function exigirEnlaceDeFormato(req, _res, next) {
  try {
    req.enlaceDeFormato = enlaceDeFormato(req.params.token);
    return next();
  } catch (error) {
    return next(error);
  }
}

router.post(
  '/formato/:token',
  exigirEnlaceDeFormato,
  recibirFormato,
  asyncHandler(async (req, res) => {
    const { userId, productCode } = req.enlaceDeFormato;

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new ValidationError('No llegó ningún archivo. Elige el .docx de tu formato y vuelve a subirlo.');
    }
    if (!(await tieneLicenciaVigente(userId, productCode))) {
      throw new ForbiddenError('Tu licencia de este método no está vigente, así que no se puede guardar el formato.');
    }

    try {
      const { estilos, mensaje } = await projectService.guardarPlantilla({
        userId,
        productCode,
        buffer: req.body,
        nombre: decodificar(req.get('X-Nombre-Archivo')),
      });
      const formato = await projectService.formatoDelProyecto(userId, productCode);
      return ok(
        res,
        { cuantos: estilos.length, formato },
        { message: `${mensaje} Vuelve a tu conversación y di que ya subiste tu formato.` },
      );
    } catch (error) {
      // Los mensajes de la plantilla están escritos para el tesista: van tal cual.
      if (error instanceof PlantillaNoValida) throw new ValidationError(error.message);
      throw error;
    }
  }),
);

// ── El material del curso (informe estudiantil) ────────────────────────────
//
// Mismo esquema que el formato: un enlace firmado que da Claude, sin sesión. El
// estudiante sube la consigna, la rúbrica o el índice y Claude lo lee con
// «material_del_curso». No toca el formato del Word.

const subidaMaterial = require('./project.subida-material');
const materialService = require('./material.service');
const { MaterialNoValido, MAXIMO_BYTES: MAXIMO_MATERIAL } = require('./project.material');

function enlaceDeMaterial(token) {
  try {
    return subidaMaterial.verificar(token);
  } catch (error) {
    throw new NotFoundError(
      mensajeEnlaceNoVale(error, { para: 'subir material', minutos: subidaMaterial.MINUTOS }),
    );
  }
}

const cuerpoDeMaterial = express.raw({ type: () => true, limit: MAXIMO_MATERIAL });

function recibirMaterial(req, res, next) {
  cuerpoDeMaterial(req, res, (error) => {
    if (error?.type === 'entity.too.large') {
      return next(
        new ValidationError(
          `Ese archivo pasa de ${MAXIMO_MATERIAL / 1024 / 1024} MB. Sube solo la consigna, la rúbrica o el índice.`,
        ),
      );
    }
    return next(error);
  });
}

router.get(
  '/material/:token',
  asyncHandler(async (req, res) => {
    const enlace = enlaceDeMaterial(req.params.token);
    const material = await materialService.lista(enlace.userId, enlace.productCode);
    // En un informe de empresa se suben los términos de referencia, no la consigna del docente.
    const ambito = (await projectService.esInformeDeEmpresa(enlace.userId, enlace.productCode)) ? 'empresa' : null;
    return ok(res, { caduca: enlace.caduca.toISOString(), material, ambito });
  }),
);

router.post(
  '/material/:token',
  recibirMaterial,
  asyncHandler(async (req, res) => {
    const { userId, productCode } = enlaceDeMaterial(req.params.token);

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new ValidationError('No llegó ningún archivo. Elígelo y vuelve a intentarlo.');
    }
    if (!(await tieneLicenciaVigente(userId, productCode))) {
      throw new ForbiddenError('Tu licencia no está vigente, así que no se puede guardar el material.');
    }

    try {
      const guardado = await materialService.guardar({
        userId,
        productCode,
        buffer: req.body,
        nombre: decodificar(req.get('X-Nombre-Archivo')),
      });
      if (!guardado) {
        throw new ForbiddenError('Tu licencia no está vigente, así que no se puede guardar el material.');
      }
      return ok(
        res,
        { material: guardado.lista },
        {
          message:
            `«${guardado.nombre}» guardado. Vuelve a tu conversación y di que ya subiste tu material.`,
        },
      );
    } catch (error) {
      // Los mensajes del material están escritos para el estudiante: van tal cual.
      if (error instanceof MaterialNoValido) throw new ValidationError(error.message);
      throw error;
    }
  }),
);

// ── El documento del tesista, desde el enlace de Claude ────────────────────
//
// Mismo esquema que el formato: sin sesión, la llave es el enlace firmado. Lo que
// se hace con el archivo es lo mismo que en la subida del perfil.

const subidaDocumento = require('./project.subida-documento');
const projectRepository = require('./project.repository');

function enlaceDeDocumento(token) {
  try {
    return subidaDocumento.verificar(token);
  } catch (error) {
    throw new NotFoundError(
      mensajeEnlaceNoVale(error, { para: 'subir tu documento', minutos: subidaDocumento.MINUTOS }),
    );
  }
}

const cuerpoDeDocumento = express.raw({ type: () => true, limit: MAXIMO_DOCUMENTO });

function recibirDocumento(req, res, next) {
  cuerpoDeDocumento(req, res, (error) => {
    if (error?.type === 'entity.too.large') {
      return next(
        new ValidationError(
          `Ese archivo pasa de ${MAXIMO_DOCUMENTO / 1024 / 1024} MB. Si lleva muchas imágenes, comprímelas en ` +
            'Word («Archivo» → «Comprimir imágenes») y vuelve a subirlo.',
        ),
      );
    }
    return next(error);
  });
}

router.get(
  '/documento-enlace/:token',
  asyncHandler(async (req, res) => {
    const enlace = enlaceDeDocumento(req.params.token);
    const proyecto = await projectRepository.buscar(enlace.userId, enlace.productCode);
    const documento = await documentoService.fichaDelPanel(proyecto);
    return ok(res, { caduca: enlace.caduca.toISOString(), documento });
  }),
);

router.post(
  '/documento-enlace/:token',
  // El enlace se comprueba ANTES de leer el archivo, que puede pesar 40 MB.
  (req, _res, next) => {
    try {
      req.enlaceDeDocumento = enlaceDeDocumento(req.params.token);
      return next();
    } catch (error) {
      return next(error);
    }
  },
  recibirDocumento,
  asyncHandler(async (req, res) => {
    const { userId, productCode } = req.enlaceDeDocumento;

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new ValidationError('No llegó ningún archivo. Elige el .docx de tu documento y vuelve a subirlo.');
    }
    if (!(await tieneLicenciaVigente(userId, productCode))) {
      throw new ForbiddenError('Tu licencia no está vigente, así que no se puede guardar el documento.');
    }

    let subido;
    try {
      subido = await documentoService.subir({
        userId,
        productCode,
        buffer: req.body,
        nombre: decodificar(req.get('X-Nombre-Archivo')),
      });
    } catch (error) {
      if (error instanceof DocumentoNoValido) throw new ValidationError(error.message);
      throw error;
    }
    if (!subido) {
      throw new ForbiddenError('Tu licencia no está vigente, así que no se puede guardar el documento.');
    }

    return ok(
      res,
      { documento: subido },
      { message: mensajeDeSubida(subido, 'Vuelve a tu conversación y di «ya lo subí».') },
    );
  }),
);

router.use(authenticate);

router.get(
  '/',
  asyncHandler(async (req, res) =>
    ok(
      res,
      await projectService.deUsuario(req.user.id, { esAdmin: req.user.role === ROLES.ADMIN }),
    ),
  ),
);

/**
 * Varias tesis del mismo método.
 *
 * Un comprador tiene UNA por método: es lo que compró. Abrir más pueden el
 * administrador —que las usa para probar el método con temas distintos— y
 * quien tenga encendido «varias tesis» en su licencia, que lo da un
 * administrador desde la ficha del acceso. Eso lo decide el servicio.
 *
 * Elegir y borrar no piden permiso a propósito: solo sirven a quien ya tiene
 * varias, y a quien se le quitó el permiso tiene que poder quedarse con una.
 */
router.post(
  '/:productCode/tesis',
  asyncHandler(async (req, res) => {
    const datos = nuevaTesisSchema.safeParse(req.body ?? {});
    if (!datos.success) {
      throw new ValidationError(datos.error.issues[0]?.message ?? 'Ponle un nombre para distinguirla.');
    }

    const { tesis, error } = await projectService.crearTesis({
      userId: req.user.id,
      productCode: req.params.productCode,
      nombre: datos.data.nombre,
      esAdmin: req.user.role === ROLES.ADMIN,
    });
    if (error === 'sin-licencia') {
      throw new ForbiddenError('Necesitas una licencia vigente de este método para abrir otra tesis.');
    }
    if (error === 'sin-permiso') {
      throw new ForbiddenError(
        'Tu licencia es para una sola tesis. Si necesitas otra, escríbenos por WhatsApp.',
      );
    }

    return ok(res, { id: tesis.id }, {
      message: `«${tesis.nombre}» es ahora tu tesis activa. Claude trabajará con ella.`,
    });
  }),
);

router.patch(
  '/:productCode/tesis/:id/activar',
  asyncHandler(async (req, res) => {
    const activada = await projectService.activarTesis({
      userId: req.user.id,
      productCode: req.params.productCode,
      id: req.params.id,
    });
    if (!activada) {
      return res.status(404).json({ success: false, message: 'Esa tesis no existe.' });
    }
    return ok(res, { activada }, { message: 'Listo. Claude trabajará con esta tesis.' });
  }),
);

router.delete(
  '/:productCode/tesis/:id',
  asyncHandler(async (req, res) => {
    const datos = borrarProyectoSchema.safeParse(req.body ?? {});
    if (!datos.success) {
      throw new ValidationError(datos.error.issues[0]?.message ?? 'Escribe «eliminar» para confirmar.');
    }

    const resultado = await projectService.eliminarTesis({
      userId: req.user.id,
      productCode: req.params.productCode,
      id: req.params.id,
    });
    if (resultado === 'no-existe') {
      return res.status(404).json({ success: false, message: 'Esa tesis no existe.' });
    }
    if (resultado === 'unica') {
      throw new ValidationError(
        'Es tu única tesis de este método. Para vaciarla usa «Borrar mi progreso y empezar de cero».',
      );
    }
    return ok(res, { borrada: true }, { message: 'Tesis borrada.' });
  }),
);

/** Las normas de citas que se pueden elegir. Las mismas que ofrece el conector. */
router.get(
  '/normas',
  asyncHandler(async (req, res) => ok(res, projectService.normasDisponibles())),
);

/** Cambia la norma de citas del proyecto. Se aplica en la próxima descarga. */
router.patch(
  '/:productCode/norma',
  asyncHandler(async (req, res) => {
    const datos = normaSchema.safeParse(req.body ?? {});
    if (!datos.success) {
      throw new ValidationError(datos.error.issues[0]?.message ?? 'Esa norma de citas no está disponible.');
    }

    const norma = await projectService.cambiarNorma({
      userId: req.user.id,
      productCode: req.params.productCode,
      ...datos.data,
    });

    if (!norma) {
      return res.status(404).json({
        success: false,
        message:
          'Todavía no hay ningún proyecto de este método. Empieza a trabajar con Claude y vuelve.',
      });
    }

    return ok(res, norma, { message: `Norma de citas: ${norma.nombre}.` });
  }),
);

/** El autor, para la portada. */
router.patch(
  '/:productCode/autor',
  asyncHandler(async (req, res) => {
    const datos = autorSchema.safeParse(req.body ?? {});
    if (!datos.success) {
      throw new ValidationError(datos.error.issues[0]?.message ?? 'Ese nombre no es válido.');
    }

    const autor = await projectService.cambiarAutor({
      userId: req.user.id,
      productCode: req.params.productCode,
      autor: datos.data.autor,
    });
    if (autor === null) {
      return res.status(404).json({
        success: false,
        message: 'Todavía no hay ningún proyecto de este método.',
      });
    }

    return ok(res, { autor }, {
      message: autor ? `Listo: «${autor}» saldrá en tu portada.` : 'Autor actualizado en tu portada.',
    });
  }),
);

/** El asesor, para la portada. Vacío lo quita. */
router.patch(
  '/:productCode/asesor',
  asyncHandler(async (req, res) => {
    const datos = asesorSchema.safeParse(req.body ?? {});
    if (!datos.success) {
      throw new ValidationError(datos.error.issues[0]?.message ?? 'Ese nombre no es válido.');
    }

    const asesor = await projectService.cambiarAsesor({
      userId: req.user.id,
      productCode: req.params.productCode,
      asesor: datos.data.asesor,
    });
    if (asesor === null) {
      return res.status(404).json({
        success: false,
        message: 'Todavía no hay ningún proyecto de este método.',
      });
    }

    return ok(res, { asesor }, {
      message: asesor ? `Listo: «${asesor}» saldrá en tu portada.` : 'Asesor quitado de tu portada.',
    });
  }),
);

/**
 * Por qué fase retomar. La eligen en el panel cuando tienen varias a medias;
 * `null` vuelve a la de siempre. Lo lee también el conector.
 */
router.patch(
  '/:productCode/retomar',
  asyncHandler(async (req, res) => {
    const datos = retomarSchema.safeParse(req.body ?? {});
    if (!datos.success) throw new ValidationError('Esa fase no es válida.');

    const resultado = await projectService.cambiarRetomar({
      userId: req.user.id,
      productCode: req.params.productCode,
      capitulo: datos.data.capitulo,
    });

    if (resultado.error === 'sin-proyecto') {
      return res.status(404).json({
        success: false,
        message: 'Todavía no hay ningún proyecto de este método.',
      });
    }
    if (resultado.error === 'no-es-fase') {
      throw new ValidationError('Esa fase no es de este método.');
    }
    if (resultado.error === 'cerrada') {
      throw new ValidationError('Esa fase ya está terminada: elige una que no lo esté.');
    }

    return ok(res, null, {
      message: datos.data.capitulo
        ? 'Listo: Claude retomará por ahí.'
        : 'Listo: vuelves a la fase que toca por orden.',
    });
  }),
);

/**
 * Deja de usar la portada de su plantilla: para cuando la detección se equivocó.
 * Estilos, márgenes, encabezado y pie se quedan.
 */
router.delete(
  '/:productCode/plantilla/portada',
  asyncHandler(async (req, res) => {
    const quitada = await projectService.quitarPortadaDePlantilla(req.user.id, req.params.productCode);
    return ok(res, { quitada }, {
      message: quitada
        ? 'Listo: tu Word sale con nuestra portada. El resto del formato de tu facultad se queda.'
        : 'Tu plantilla no tenía portada en uso.',
    });
  }),
);

/**
 * Devuelve el proyecto al comienzo: borra avance, capítulos escritos, análisis y
 * plantilla, y deja el método con sus fases en blanco.
 *
 * Es la única forma de empezar de cero. El conector no puede hacerlo —anota,
 * pero no olvida—, y tiene que poder hacerlo el dueño cuando le cambian el tema.
 */
router.delete(
  '/:productCode',
  asyncHandler(async (req, res) => {
    const datos = borrarProyectoSchema.safeParse(req.body ?? {});
    if (!datos.success) {
      throw new ValidationError(datos.error.issues[0]?.message ?? 'Escribe «eliminar» para confirmar.');
    }

    const resultado = await projectService.reiniciarProyecto(req.user.id, req.params.productCode, {
      esAdmin: req.user.role === ROLES.ADMIN,
    });
    if (resultado.error === 'sin-proyecto') {
      return res.status(404).json({
        success: false,
        message: 'No hay ningún proyecto de este método que borrar.',
      });
    }
    if (resultado.error === 'sin-reinicios') {
      throw new ForbiddenError(
        'Ya usaste las tres veces que puedes empezar de cero esta tesis. Si de verdad te cambiaron ' +
          'el tema, escríbenos y lo vemos contigo.',
      );
    }

    return ok(res, { reiniciado: true, restantes: resultado.restantes }, {
      message: 'Tu proyecto volvió al comienzo. La próxima vez que trabajes con Claude empezará de cero.',
    });
  }),
);

/**
 * La tesis en Word, con todo lo escrito hasta ahora.
 *
 * Se arma en el momento y no se guarda: el documento es la suma de los
 * capítulos, y guardarlo obligaría a rehacerlo cada vez que cambia uno o a
 * servir uno viejo. Armarlo cuesta décimas de segundo.
 *
 * El producto va en la dirección porque un comprador puede tener la ruta de
 * tesis y la de artículo a la vez, y son documentos distintos.
 */
router.get(
  '/:productCode/word',
  asyncHandler(async (req, res) => {
    const documento = await projectService.armarWord(req.user.id, req.params.productCode);

    if (!documento) {
      // 404 y no un Word vacío: un archivo con la portada y nada dentro parece
      // que el servidor perdió el trabajo de alguien.
      return res.status(404).json({
        success: false,
        message:
          'Todavía no hay ningún capítulo escrito. Pídele a Claude que guarde lo que tengas ' +
          'redactado y vuelve a intentarlo.',
      });
    }

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${documento.nombreArchivo}"`);
    return res.send(documento.buffer);
  }),
);

/**
 * La bibliografía en BibTeX, para quien escribe la tesis en LaTeX.
 *
 * Sale de las MISMAS citas que el Word, así que las dos salidas no pueden
 * discrepar. Y las claves del `.bib` son las que ya están entre corchetes en sus
 * capítulos: `[AR97D22F86]` en el texto es `\cite{AR97D22F86}` en LaTeX.
 */
router.get(
  '/:productCode/bib',
  asyncHandler(async (req, res) => {
    const archivo = await projectService.armarBibtex(req.user.id, req.params.productCode);

    if (!archivo) {
      // Un `.bib` vacío compila y no imprime nada, así que el tesista lo
      // descubriría al final mirando una bibliografía en blanco. Y se dice qué
      // falta exactamente: no es que no haya capítulos, es que no hay ninguna
      // cita puesta en ellos, que se arregla de otra manera.
      return res.status(404).json({
        success: false,
        message:
          'Todavía no hay ninguna cita en tus capítulos, así que no hay bibliografía que ' +
          'exportar. Pídele fuentes a Claude mientras redactas y volverá a haber algo aquí.',
      });
    }

    // El `charset` va explícito porque el archivo lleva tildes y eñes: sin
    // declararlo, quien lo abra en un editor que suponga Latin-1 ve los
    // apellidos rotos, y los apellidos son justo lo que no puede salir mal.
    res.setHeader('Content-Type', 'text/x-bibtex; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${archivo.nombreArchivo}"`);
    return res.send(archivo.contenido);
  }),
);

/**
 * La plantilla de su facultad.
 *
 * El cuerpo va en crudo y con su propio techo, como el comprobante de Yape y el
 * export de Scopus: el límite general de 100 KB es lo correcto para JSON y
 * ridículo para un .docx. Se abre aquí y solo aquí.
 *
 * El nombre del archivo llega por cabecera y NO se usa para escribir nada en
 * disco —el archivo se guarda por el identificador del proyecto—: solo sirve
 * para poder enseñarle al tesista cuál subió.
 */
router.post(
  '/:productCode/plantilla',
  express.raw({
    type: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/octet-stream',
    ],
    limit: MAXIMO_BYTES,
  }),
  asyncHandler(async (req, res) => {
    // Viene codificado porque una cabecera HTTP solo admite Latin-1 y estos
    // archivos se llaman «Plantilla de tesis UNMSM (versión final).docx».
    const nombre = decodificar(req.get('X-Nombre-Archivo'));

    try {
      const guardada = await projectService.guardarPlantilla({
        userId: req.user.id,
        productCode: req.params.productCode,
        buffer: req.body,
        nombre,
      });
      if (!guardada) {
        throw new ForbiddenError('Necesitas una licencia vigente de este método para subir tu plantilla.');
      }
      const { estilos, mensaje } = guardada;

      return ok(
        res,
        { estilos: estilos.slice(0, 20), cuantos: estilos.length },
        {
          message: mensaje,
        },
      );
    } catch (error) {
      // Lo que sale de aquí lo lee alguien que subió el archivo equivocado, no
      // un programador: su mensaje ya está escrito para eso y se pasa tal cual.
      if (error instanceof PlantillaNoValida) throw new ValidationError(error.message);
      throw error;
    }
  }),
);

router.delete(
  '/:productCode/plantilla',
  asyncHandler(async (req, res) => {
    const quitada = await projectService.quitarPlantilla(req.user.id, req.params.productCode);
    return ok(res, { quitada }, {
      message: quitada
        ? 'Plantilla quitada. Las próximas descargas saldrán con el formato de tesis por defecto.'
        : 'No había ninguna plantilla puesta.',
    });
  }),
);

/**
 * La tesis o el artículo que el tesista escribió por su cuenta, para que Claude
 * le ponga las citas (ver `documento.service`).
 *
 * Crudo y con su propio techo, como la plantilla, pero más alto: aquí llega el
 * documento entero, con sus figuras. Solo con licencia vigente del método.
 */
router.post(
  '/:productCode/documento',
  express.raw({ type: [TIPO_DOCX, 'application/octet-stream'], limit: MAXIMO_DOCUMENTO }),
  asyncHandler(async (req, res) => {
    let subido;
    try {
      subido = await documentoService.subir({
        userId: req.user.id,
        productCode: req.params.productCode,
        buffer: req.body,
        nombre: decodificar(req.get('X-Nombre-Archivo')),
      });
    } catch (error) {
      if (error instanceof DocumentoNoValido) throw new ValidationError(error.message);
      throw error;
    }

    if (!subido) {
      throw new ForbiddenError('Necesitas una licencia vigente de este método para subir tu documento.');
    }

    return ok(res, subido, {
      message: mensajeDeSubida(subido, 'Ahora abre Claude y dile: «cita mi documento» o «humaniza mi documento».'),
    });
  }),
);

/** Lo que se le dice al subir el documento, desde el perfil o desde el enlace de Claude. */
function mensajeDeSubida(subido, cierre) {
  const conservadas =
    subido.citados > 0 ? ` Se conservaron las citas de ${subido.citados} párrafos que ya tenías.` : '';
  const perdidas =
    subido.perdidos > 0
      ? ` ${subido.perdidos} párrafos citados ya no están igual en esta versión: pídele a Claude que los revise.`
      : '';
  const humanizados =
    subido.humanizados > 0 ? ` Se conservó lo humanizado en ${subido.humanizados} párrafos.` : '';
  const humanizadosPerdidos =
    subido.humanizadosPerdidos > 0
      ? ` ${subido.humanizadosPerdidos} párrafos humanizados cambiaron en esta versión y habrá que revisarlos de nuevo.`
      : '';
  return (
    `Listo: «${subido.nombre}», ${subido.parrafos} párrafos.${conservadas}${perdidas}${humanizados}` +
    `${humanizadosPerdidos} ${cierre}`
  );
}

router.delete(
  '/:productCode/documento',
  asyncHandler(async (req, res) => {
    const quitado = await documentoService.quitar(req.user.id, req.params.productCode);
    return ok(res, { quitado }, {
      message: quitado ? 'Documento quitado, con sus citas.' : 'No había ningún documento subido.',
    });
  }),
);

/** Su documento con las citas y la lista de referencias, en la norma del proyecto. */
router.get(
  '/:productCode/documento',
  asyncHandler(async (req, res) => {
    let citado;
    try {
      citado = await documentoService.armar(req.user.id, req.params.productCode);
    } catch (error) {
      if (error instanceof NormaConNotas) throw new ValidationError(error.message);
      throw error;
    }

    if (!citado) {
      return res.status(404).json({ success: false, message: 'No has subido ningún documento.' });
    }

    res.setHeader('Content-Type', TIPO_DOCX);
    res.setHeader('Content-Disposition', `attachment; filename="${citado.nombreArchivo}"`);
    return res.send(citado.buffer);
  }),
);

/*
 * Aquí estaba `POST /:productCode/analisis`, el botón «Enviar a mi conector» de
 * la página de R en el navegador. Esa página se retiró el 15 de septiembre de
 * 2026: el análisis lo corre Claude con «trabajar_en_r» y se guarda solo en el
 * proyecto (ver `r.service`, que sigue usando `recibirAnalisis`).
 */

module.exports = router;

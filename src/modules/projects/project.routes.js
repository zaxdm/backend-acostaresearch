'use strict';

const { Router } = require('express');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const { ValidationError } = require('../../shared/errors/AppError');
const projectService = require('./project.service');
const { PlantillaNoValida, MAXIMO_BYTES } = require('./project.plantilla');

const router = Router();

/**
 * El proyecto es de quien lo escribe.
 *
 * Todas las rutas trabajan sobre `req.user.id` y ninguna acepta de quién por
 * parámetro. Un identificador de usuario que viaje en la petición es la forma
 * más rápida de acabar enseñando la tesis de otro — y aquí, además de fuentes,
 * hay lo que alguien ha decidido sobre su propia investigación.
 */
router.use(authenticate);

router.get(
  '/',
  asyncHandler(async (req, res) => ok(res, await projectService.deUsuario(req.user.id))),
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
    const nombre = String(req.get('X-Nombre-Archivo') ?? '').slice(0, 200) || null;

    try {
      const { estilos } = await projectService.guardarPlantilla({
        userId: req.user.id,
        productCode: req.params.productCode,
        buffer: req.body,
        nombre,
      });

      return ok(
        res,
        { estilos: estilos.slice(0, 20), cuantos: estilos.length },
        {
          message:
            `Plantilla guardada, con ${estilos.length} estilos. Tu próxima descarga saldrá ` +
            'con el formato de tu facultad.',
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

module.exports = router;

'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const projectService = require('./project.service');

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

module.exports = router;

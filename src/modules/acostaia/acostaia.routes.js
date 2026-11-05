'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const env = require('../../config/env');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created } = require('../../shared/http/apiResponse');
const {
  crearAccesoSchema,
  revocarAccesoSchema,
  fuentesSchema,
  documentosSchema,
  enlaceSchema,
  subidaSchema,
  conectoresSchema,
  conectorSchema,
  elegirColeccionSchema,
  irSchema,
} = require('./acostaia.schema');
const acostaiaService = require('./acostaia.service');
const acostaiaDatos = require('./acostaia.datos');
const acostaiaConectores = require('./acostaia.conectores');

const router = Router();

function coincide(recibido, esperado) {
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Solo el servidor de AcostaIA: trae la clave compartida en
 * `Authorization: Bearer`. Sin `ACOSTAIA_CLAVE_INTERNA` en el .env la ruta
 * está cerrada para todos.
 */
function soloAcostaIA(req, res, next) {
  const cabecera = req.get('Authorization') ?? '';
  const clave = cabecera.startsWith('Bearer ') ? cabecera.slice(7).trim() : '';

  if (!env.ACOSTAIA_CLAVE_INTERNA || !coincide(clave, env.ACOSTAIA_CLAVE_INTERNA)) {
    return res
      .status(401)
      .json({ success: false, error: { code: 'UNAUTHORIZED', message: 'No autorizado.' } });
  }
  return next();
}

/**
 * GET /acostaia/conectores/ir?pase=… — la abre el NAVEGADOR del usuario de
 * AcostaIA, por eso va antes de `soloAcostaIA`: el pase (de un solo uso, 2
 * minutos) es su identidad. Deja la cookie que ata el intercambio a este
 * navegador, igual que «Conectar» del perfil, y lo manda a Zotero o Mendeley.
 * Responde siempre con una redirección: un JSON aquí sería una pantalla rota.
 */
router.get(
  '/conectores/ir',
  validate({ query: irSchema }),
  asyncHandler(async (req, res) => {
    let empezado;
    try {
      empezado = await acostaiaConectores.ir(req.query.pase);
    } catch {
      return res.redirect(env.ACOSTAIA_URL ? acostaiaConectores.urlDeVuelta('conector', 'caducado') : env.APP_URL);
    }
    const controlador =
      empezado.cual === 'zotero'
        ? require('../zotero/biblioteca.controller')
        : require('../mendeley/mendeley.controller');
    const { nombre, opciones } = controlador.cookieDelIntercambio();
    res.cookie(nombre, empezado.marca, opciones);
    return res.redirect(empezado.url);
  }),
);

router.use(soloAcostaIA);

/** POST /acostaia/accesos — licencia nueva de un producto para un usuario de AcostaIA. */
router.post(
  '/accesos',
  validate({ body: crearAccesoSchema }),
  asyncHandler(async (req, res) => created(res, await acostaiaService.crearAcceso(req.body))),
);

/** POST /acostaia/accesos/revocar — corta sus licencias (de un producto o todas). */
router.post(
  '/accesos/revocar',
  validate({ body: revocarAccesoSchema }),
  asyncHandler(async (req, res) => ok(res, await acostaiaService.revocarAcceso(req.body))),
);

/** GET /acostaia/fuentes — «Mis fuentes» del usuario de AcostaIA. */
router.get(
  '/fuentes',
  validate({ query: fuentesSchema }),
  asyncHandler(async (req, res) => ok(res, await acostaiaDatos.fuentes(req.query))),
);

/** GET /acostaia/documentos — «Mis documentos»: sus trabajos y en qué fase va cada uno. */
router.get(
  '/documentos',
  validate({ query: documentosSchema }),
  asyncHandler(async (req, res) => ok(res, await acostaiaDatos.documentos(req.query))),
);

/** POST /acostaia/documentos/enlace — un enlace de descarga recién firmado (o null). */
router.post(
  '/documentos/enlace',
  validate({ body: enlaceSchema }),
  asyncHandler(async (req, res) => ok(res, await acostaiaDatos.enlace(req.body))),
);

/** POST /acostaia/documentos/subida — el permiso (token de media hora) para subir su avance. */
router.post(
  '/documentos/subida',
  validate({ body: subidaSchema }),
  asyncHandler(async (req, res) => ok(res, await acostaiaDatos.subida(req.body))),
);

/** GET /acostaia/conectores — cómo están su Zotero y su Mendeley. */
router.get(
  '/conectores',
  validate({ query: conectoresSchema }),
  asyncHandler(async (req, res) => ok(res, await acostaiaConectores.estado(req.query))),
);

/** POST /acostaia/conectores/pase — la dirección de un solo uso para conectar. */
router.post(
  '/conectores/pase',
  validate({ body: conectorSchema }),
  asyncHandler(async (req, res) => ok(res, await acostaiaConectores.pase(req.body))),
);

/** GET /acostaia/conectores/colecciones — sus colecciones (Zotero) o carpetas (Mendeley). */
router.get(
  '/conectores/colecciones',
  validate({ query: conectorSchema }),
  asyncHandler(async (req, res) => ok(res, await acostaiaConectores.colecciones(req.query))),
);

/** POST /acostaia/conectores/coleccion — elige qué se trae, y empieza a traerlo. */
router.post(
  '/conectores/coleccion',
  validate({ body: elegirColeccionSchema }),
  asyncHandler(async (req, res) => ok(res, await acostaiaConectores.elegir(req.body))),
);

/** POST /acostaia/conectores/sincronizar — trae lo nuevo. */
router.post(
  '/conectores/sincronizar',
  validate({ body: conectorSchema }),
  asyncHandler(async (req, res) => ok(res, await acostaiaConectores.sincronizar(req.body))),
);

/** POST /acostaia/conectores/desconectar — las fuentes ya traídas se quedan. */
router.post(
  '/conectores/desconectar',
  validate({ body: conectorSchema }),
  asyncHandler(async (req, res) => ok(res, await acostaiaConectores.desconectar(req.body))),
);

module.exports = router;

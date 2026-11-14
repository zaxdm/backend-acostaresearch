'use strict';
const { Router } = require('express');
const { autorizado } = require('./social.auth');
const env = require('../../config/env');
const asyncHandler = require('../../shared/http/asyncHandler');
const { UnauthorizedError } = require('../../shared/errors/AppError');
const schema = require('./social.schema');
const validate = require('../../middlewares/validate');
const service = require('./social.service');
const router = Router();
router.use((req, _res, next) => {
  if (!autorizado(req.get('authorization'), env.SOCIAL_BOT_SECRET)) return next(new UnauthorizedError());
  next();
});
router.post('/mensaje', validate({ body: schema.mensaje }), asyncHandler(async (req, res) => {
  res.json(await service.atender(req.body));
}));
router.post('/modo', validate({ body: schema.modo }), asyncHandler(async (req, res) => {
  const datos = req.body;
  await service.modo(datos);
  res.json({ success: true, humano: datos.humano });
}));
module.exports = router;
module.exports.autorizado = autorizado;

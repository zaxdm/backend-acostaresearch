'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created } = require('../../shared/http/apiResponse');
const rewriteService = require('./rewrite.service');

const rewriteController = {
  create: asyncHandler(async (req, res) => {
    const rewrite = await rewriteService.rewrite({
      userId: req.user.id,
      text: req.body.text,
      mode: req.body.mode,
      chapter: req.body.chapter,
    });
    return created(res, { rewrite }, 'Texto reescrito.');
  }),

  list: asyncHandler(async (req, res) => {
    const { items, meta } = await rewriteService.list(req.user.id, req.query);
    return ok(res, { rewrites: items, meta });
  }),

  detail: asyncHandler(async (req, res) => {
    const rewrite = await rewriteService.get(req.params.id, req.user.id);
    return ok(res, { rewrite });
  }),
};

module.exports = rewriteController;

'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const userService = require('./user.service');

const userController = {
  me: asyncHandler(async (req, res) => {
    const user = await userService.getProfile(req.user.id);
    return ok(res, { user });
  }),

  list: asyncHandler(async (req, res) => {
    const { items, meta } = await userService.list(req.query);
    return ok(res, { users: items, meta });
  }),
};

module.exports = userController;

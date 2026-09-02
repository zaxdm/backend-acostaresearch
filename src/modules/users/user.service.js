'use strict';

const userRepository = require('./user.repository');
const { NotFoundError } = require('../../shared/errors/AppError');

const userService = {
  async getProfile(userId) {
    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError('El usuario ya no existe.');
    return user;
  },

  list({ page, perPage, search }) {
    return userRepository.paginate({ page, perPage, search });
  },
};

module.exports = userService;

'use strict';

/** Envuelve un handler async para que sus rechazos lleguen al errorHandler. */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;

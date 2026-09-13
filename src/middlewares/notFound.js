'use strict';

const { NotFoundError } = require('../shared/errors/AppError');
const { ocultarSecretosEnUrl } = require('../shared/utils/ocultar');

// La ruta va en el mensaje, y el mensaje acaba en el registro y en la respuesta:
// una licencia pegada en una ruta equivocada saldría por los dos lados.
function notFound(req, _res, next) {
  next(new NotFoundError(`La ruta ${req.method} ${ocultarSecretosEnUrl(req.originalUrl)} no existe.`));
}

module.exports = notFound;

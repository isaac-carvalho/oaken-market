const jwt = require('jsonwebtoken');
const { HttpError } = require('./errorHandler');

function requireAuth(env) {
  return function (req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return next(new HttpError(401, 'Sessão em falta'));

    try {
      req.user = jwt.verify(token, env.jwtSecret);
      next();
    } catch {
      next(new HttpError(401, 'Sessão inválida ou expirada'));
    }
  };
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'ADMIN') return next(new HttpError(403, 'Sem permissão'));
  next();
}

module.exports = { requireAuth, requireAdmin };

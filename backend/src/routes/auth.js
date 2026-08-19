const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { prisma } = require('../config/prisma');
const { HttpError } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');

const BCRYPT_COST = 12;
const TOKEN_EXPIRY = '7d';

// Hash "vazio" só para gastar o mesmo tempo de bcrypt.compare quando o
// email não existe — sem isto, responder mais depressa nesse caso do que
// quando a senha está errada permite adivinhar emails registados pelo
// tempo de resposta.
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEeOAOWJoZ0Q8T4y0kMFtR5V6c6nJ8v2Nsm';

const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email('Email inválido'),
  password: z
    .string()
    .min(8, 'Password deve ter no mínimo 8 caracteres')
    .regex(/[0-9]/, 'Password deve ter pelo menos 1 número')
    .regex(/[A-Z]/, 'Password deve ter pelo menos 1 maiúscula'),
  name: z.string().trim().min(1, 'Nome não pode estar vazio'),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Email inválido'),
  password: z.string().min(1, 'Password em falta'),
});

function toSafeUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}

function signToken(user, env) {
  return jwt.sign({ sub: user.id, role: user.role }, env.jwtSecret, {
    expiresIn: TOKEN_EXPIRY,
  });
}

module.exports = function (env) {
  const router = express.Router();

  router.post('/signup', async (req, res, next) => {
    try {
      const parsed = signupSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }
      const { email, password, name } = parsed.data;

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return next(new HttpError(409, 'Email já registado'));
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

      const user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          name,
          role: 'BUYER',
        },
      });

      const token = signToken(user, env);
      res.status(201).json({ token, user: toSafeUser(user) });
    } catch (err) {
      // Guarda de segurança extra caso um pedido concorrente passe a
      // verificação findUnique antes do commit (condição de corrida) e
      // dispare a constraint única do Prisma (P2002).
      if (err && err.code === 'P2002') {
        return next(new HttpError(409, 'Email já registado'));
      }
      next(err);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }
      const { email, password } = parsed.data;

      const user = await prisma.user.findUnique({ where: { email } });
      const valid = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
      if (!user || !valid) {
        return next(new HttpError(401, 'Email ou senha inválidos'));
      }

      const token = signToken(user, env);
      res.json({ token, user: toSafeUser(user) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/me', requireAuth(env), async (req, res, next) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
      if (!user) {
        return next(new HttpError(401, 'Sessão inválida ou expirada'));
      }
      res.json({ user: toSafeUser(user) });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

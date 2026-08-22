const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { z } = require('zod');
const { prisma } = require('../config/prisma');
const { HttpError } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');

const BCRYPT_COST = 12;
const TOKEN_EXPIRY = '7d';
const ISSUER = 'Oaken Market';

// Tolera 1 passo de 30s para cada lado (relógio do telemóvel ligeiramente
// dessincronizado) — nem tão apertado que rejeite códigos válidos, nem tão
// largo que aumente muito a janela de força bruta (já limitada pelo
// authLimiter em index.js, 20 pedidos/15min por IP em todo o /api/auth).
authenticator.options = { window: 1 };

// Desafios de 2FA no login: token opaco (não é JWT) guardado só em memória
// do processo, nunca aceite por requireAuth — mesmo que vazasse, não dá
// acesso a nada além de completar ESTE login pendente, e expira sozinho.
// Suficiente para esta fase (uma única instância do backend); se um dia
// houver múltiplas instâncias, isto precisa de passar para a BD/Redis.
const pending2FAChallenges = new Map(); // token -> { userId, expiresAt }
const PENDING_2FA_TTL_MS = 5 * 60 * 1000;

function sweepExpiredChallenges() {
  const now = Date.now();
  for (const [token, entry] of pending2FAChallenges) {
    if (entry.expiresAt <= now) pending2FAChallenges.delete(token);
  }
}

function createPendingChallenge(userId) {
  sweepExpiredChallenges();
  const token = crypto.randomBytes(32).toString('hex');
  pending2FAChallenges.set(token, { userId, expiresAt: Date.now() + PENDING_2FA_TTL_MS });
  return token;
}

function consumePendingChallenge(token) {
  const entry = pending2FAChallenges.get(token);
  if (!entry) return null;
  pending2FAChallenges.delete(token); // um uso só, mesmo que o código esteja errado
  if (entry.expiresAt <= Date.now()) return null;
  return entry.userId;
}

// Hash "vazio" só para gastar o mesmo tempo de bcrypt.compare quando o
// email não existe — sem isto, responder mais depressa nesse caso do que
// quando a senha está errada permite adivinhar emails registados pelo
// tempo de resposta.
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEeOAOWJoZ0Q8T4y0kMFtR5V6c6nJ8v2Nsm';

// Reaproveitada no signup e na mudança de password — mesma política nos
// dois sítios, para não haver um caminho mais fraco que o outro.
const passwordSchema = z
  .string()
  .min(8, 'Password deve ter no mínimo 8 caracteres')
  .regex(/[0-9]/, 'Password deve ter pelo menos 1 número')
  .regex(/[A-Z]/, 'Password deve ter pelo menos 1 maiúscula');

const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email('Email inválido'),
  password: passwordSchema,
  name: z.string().trim().min(1, 'Nome não pode estar vazio'),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Email inválido'),
  password: z.string().min(1, 'Password em falta'),
});

const updateMeSchema = z
  .object({
    name: z.string().trim().min(1, 'Nome não pode estar vazio'),
  })
  .strict();

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Password actual em falta'),
    newPassword: passwordSchema,
  })
  .strict();

// Código TOTP: sempre 6 dígitos numéricos.
const totpTokenSchema = z.string().trim().regex(/^\d{6}$/, 'Código tem de ter 6 dígitos');

const twoFactorVerifySchema = z.object({ token: totpTokenSchema }).strict();

const twoFactorDisableSchema = z
  .object({ password: z.string().min(1, 'Password em falta') })
  .strict();

const twoFactorLoginVerifySchema = z
  .object({
    pendingToken: z.string().min(1, 'pendingToken em falta'),
    token: totpTokenSchema,
  })
  .strict();

// Nunca deixar os campos de 2FA saírem em nenhuma resposta — nem sequer o
// booleano bruto do segredo temporário, só o essencial para a UI decidir
// o que mostrar.
function toSafeUser(user) {
  const { passwordHash, twoFactorSecret, twoFactorTempSecret, ...safe } = user;
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

      // Com 2FA activo, a password certa só abre a segunda etapa — o
      // token de sessão completo só sai depois de POST /2fa/login-verify
      // com o código certo. pendingToken é opaco (não é JWT, não passa em
      // requireAuth), só serve para completar este login pendente.
      if (user.twoFactorEnabled) {
        const pendingToken = createPendingChallenge(user.id);
        return res.json({ requires2FA: true, pendingToken });
      }

      const token = signToken(user, env);
      res.json({ token, user: toSafeUser(user) });
    } catch (err) {
      next(err);
    }
  });

  // Segunda etapa do login quando a conta tem 2FA activo. pendingToken
  // vem da resposta de /login (requires2FA: true) — de uso único, expira
  // em 5min, e não dá acesso a nada além de completar este login.
  router.post('/2fa/login-verify', async (req, res, next) => {
    try {
      const parsed = twoFactorLoginVerifySchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }
      const { pendingToken, token: totpToken } = parsed.data;

      const userId = consumePendingChallenge(pendingToken);
      if (!userId) {
        return next(new HttpError(401, 'Sessão de verificação inválida ou expirada — inicia sessão outra vez'));
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
        return next(new HttpError(401, 'Sessão de verificação inválida ou expirada — inicia sessão outra vez'));
      }

      const isValid = authenticator.verify({ token: totpToken, secret: user.twoFactorSecret });
      if (!isValid) {
        return next(new HttpError(401, 'Código inválido'));
      }

      const finalToken = signToken(user, env);
      res.json({ token: finalToken, user: toSafeUser(user) });
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

  // Só o nome é editável aqui — email é a identidade da conta (mudar
  // exigiria um fluxo de reverificação que ainda não existe), e role/2FA
  // têm rotas próprias com as suas próprias regras de segurança.
  router.patch('/me', requireAuth(env), async (req, res, next) => {
    try {
      const parsed = updateMeSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }

      const user = await prisma.user.update({
        where: { id: req.user.sub },
        data: { name: parsed.data.name },
      });

      res.json({ user: toSafeUser(user) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/change-password', requireAuth(env), async (req, res, next) => {
    try {
      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }
      const { currentPassword, newPassword } = parsed.data;

      const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
      if (!user) {
        return next(new HttpError(401, 'Sessão inválida ou expirada'));
      }

      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) {
        return next(new HttpError(401, 'Password actual incorrecta'));
      }

      const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Gera um segredo novo e guarda-o em twoFactorTempSecret — ainda NÃO
  // activa 2FA. Só fica activo depois de POST /2fa/verify confirmar um
  // código válido (evita a pessoa ficar trancada de fora por ter lido mal
  // o QR code).
  router.post('/2fa/setup', requireAuth(env), async (req, res, next) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
      if (!user) {
        return next(new HttpError(401, 'Sessão inválida ou expirada'));
      }
      if (user.twoFactorEnabled) {
        return next(new HttpError(400, '2FA já está activo — desactiva primeiro para gerar um novo código'));
      }

      const secret = authenticator.generateSecret();
      await prisma.user.update({ where: { id: user.id }, data: { twoFactorTempSecret: secret } });

      const otpauthUrl = authenticator.keyuri(user.email, ISSUER, secret);
      const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

      res.json({ secret, otpauthUrl, qrCodeDataUrl });
    } catch (err) {
      next(err);
    }
  });

  // Confirma a configuração pendente com um código real do telemóvel —
  // só aqui é que twoFactorEnabled passa a true.
  router.post('/2fa/verify', requireAuth(env), async (req, res, next) => {
    try {
      const parsed = twoFactorVerifySchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }

      const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
      if (!user || !user.twoFactorTempSecret) {
        return next(new HttpError(400, 'Nenhuma configuração de 2FA pendente — chama /2fa/setup primeiro'));
      }

      const isValid = authenticator.verify({ token: parsed.data.token, secret: user.twoFactorTempSecret });
      if (!isValid) {
        return next(new HttpError(400, 'Código inválido'));
      }

      await prisma.user.update({
        where: { id: user.id },
        data: {
          twoFactorEnabled: true,
          twoFactorSecret: user.twoFactorTempSecret,
          twoFactorTempSecret: null,
        },
      });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Desactivar exige a password actual (não o código TOTP) — se a pessoa
  // perdeu o telemóvel, ainda precisa de conseguir desligar o 2FA sabendo
  // só a password.
  router.post('/2fa/disable', requireAuth(env), async (req, res, next) => {
    try {
      const parsed = twoFactorDisableSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }

      const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
      if (!user) {
        return next(new HttpError(401, 'Sessão inválida ou expirada'));
      }

      const valid = await bcrypt.compare(parsed.data.password, user.passwordHash);
      if (!valid) {
        return next(new HttpError(401, 'Password incorrecta'));
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorTempSecret: null },
      });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

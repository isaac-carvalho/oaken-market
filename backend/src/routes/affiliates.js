const express = require('express');
const { z } = require('zod');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../config/prisma');
const { HttpError } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');

const createAffiliateSchema = z.object({
  courseId: z.string().uuid('courseId inválido'),
});

module.exports = function (env) {
  const router = express.Router();

  router.use(requireAuth(env));

  // Pede para ser afiliado de um curso. Nasce sempre PENDING — só o admin
  // aprova (ver PATCH /api/admin/affiliates/:id).
  router.post('/', async (req, res, next) => {
    try {
      const parsed = createAffiliateSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }
      const { courseId } = parsed.data;

      const course = await prisma.course.findUnique({ where: { id: courseId } });
      if (!course || !course.published) {
        return next(new HttpError(404, 'Curso não encontrado'));
      }

      const affiliate = await prisma.affiliate.create({
        data: {
          userId: req.user.sub,
          courseId: course.id,
          status: 'PENDING',
        },
      });

      res.status(201).json({ affiliate });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return next(new HttpError(409, 'Já existe um pedido de afiliação para este curso'));
      }
      next(err);
    }
  });

  // Lista as afiliações do próprio utilizador autenticado — nunca as de
  // outro (sempre filtrado por req.user.sub).
  router.get('/me', async (req, res, next) => {
    try {
      const affiliates = await prisma.affiliate.findMany({
        where: { userId: req.user.sub },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          commissionPct: true,
          createdAt: true,
          decidedAt: true,
          course: { select: { title: true, slug: true } },
        },
      });

      res.json({ affiliates });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

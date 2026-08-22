const express = require('express');
const { z } = require('zod');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../config/prisma');
const { HttpError } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');

const createAffiliateSchema = z.object({
  courseId: z.string().uuid('courseId inválido'),
});

const SELLER_SLUG = 'oaken';

// Tem de bater com o default do schema (Affiliate.commissionPct @default(30),
// ver prisma/schema.prisma) — é o valor mostrado a um visitante ainda sem
// afiliação aprovada, antes de qualquer Affiliate existir para ele.
const DEFAULT_COMMISSION_PCT = 30;

const RECENT_SALES_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

// "Temperatura" da vitrine (referência: indicador de calor do Kursinha).
// Fórmula simples e transparente, sempre derivada do recentSalesCount real
// — nunca um valor à parte: TEMP_BASE_DEGREES + vendas recentes *
// TEMP_DEGREES_PER_SALE. Ex: 0 vendas = 30°, 1 venda = 50°, 3 vendas = 90°.
// O recentSalesCount real continua sempre devolvido ao lado, para nunca
// esconder o número por trás do grau.
const TEMP_BASE_DEGREES = 30;
const TEMP_DEGREES_PER_SALE = 20;

module.exports = function (env) {
  const router = express.Router();

  // Rota pública (SEM requireAuth) — tem de ficar definida ANTES do
  // `router.use(requireAuth(env))` abaixo, para que um visitante anónimo
  // consiga ver a vitrine antes de criar conta.
  //
  // Vitrine "Explorar": lista os cursos publicados do seller "oaken",
  // ordenados por vendas recentes (mais vendido primeiro). `recentSalesCount`
  // é sempre recalculado a partir de Order PAID dos últimos 30 dias — nunca
  // um número fixo ou fórmula inventada (equivalente à "temperatura" de
  // vendas do Kursinha, mas com contagem real por trás).
  router.get('/explore', async (req, res, next) => {
    try {
      const seller = await prisma.seller.findUniqueOrThrow({ where: { slug: SELLER_SLUG } });

      const courses = await prisma.course.findMany({
        where: { sellerId: seller.id, published: true },
        select: {
          id: true,
          slug: true,
          title: true,
          coverUrl: true,
          priceKz: true,
        },
      });

      const since = new Date(Date.now() - RECENT_SALES_WINDOW_MS);

      const grouped = courses.length
        ? await prisma.order.groupBy({
            by: ['courseId'],
            where: {
              courseId: { in: courses.map((c) => c.id) },
              status: 'PAID',
              createdAt: { gte: since },
            },
            _count: { _all: true },
          })
        : [];

      const recentSalesByCourseId = new Map(grouped.map((g) => [g.courseId, g._count._all]));

      const result = courses
        .map((course) => {
          const recentSalesCount = recentSalesByCourseId.get(course.id) || 0;
          return {
            id: course.id,
            slug: course.slug,
            title: course.title,
            coverUrl: course.coverUrl,
            priceKz: course.priceKz,
            commissionPct: DEFAULT_COMMISSION_PCT,
            maxCommissionKz: Math.round((course.priceKz * DEFAULT_COMMISSION_PCT) / 100),
            recentSalesCount,
            temperatureDegrees: TEMP_BASE_DEGREES + recentSalesCount * TEMP_DEGREES_PER_SALE,
          };
        })
        .sort((a, b) => b.recentSalesCount - a.recentSalesCount);

      res.json({ courses: result });
    } catch (err) {
      next(err);
    }
  });

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

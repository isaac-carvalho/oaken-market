const express = require('express');
const { z } = require('zod');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../config/prisma');
const { HttpError } = require('../middleware/errorHandler');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const SELLER_SLUG = 'oaken';

const COURSE_TYPES = ['DIGITAL', 'PHYSICAL', 'SERVICE', 'PAYMENT'];

const createCourseSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'slug só pode ter minúsculas, números e hífens'),
  title: z.string().trim().min(1, 'title em falta'),
  description: z.string().trim().min(1, 'description em falta'),
  priceKz: z.number().int('priceKz tem de ser inteiro').positive('priceKz tem de ser positivo'),
  coverUrl: z.string().url('coverUrl inválido').optional(),
  category: z.string().trim().min(1).optional(),
  type: z.enum(COURSE_TYPES).optional(),
});

const updateCourseSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    priceKz: z.number().int('priceKz tem de ser inteiro').positive('priceKz tem de ser positivo').optional(),
    coverUrl: z.string().url('coverUrl inválido').optional(),
    category: z.string().trim().min(1).optional(),
    type: z.enum(COURSE_TYPES).optional(),
    published: z.boolean().optional(),
  })
  .strict();

const createModuleSchema = z.object({
  order: z.number().int('order tem de ser inteiro').nonnegative('order não pode ser negativo'),
  title: z.string().trim().min(1, 'title em falta'),
});

const createLessonSchema = z.object({
  order: z.number().int('order tem de ser inteiro').nonnegative('order não pode ser negativo'),
  title: z.string().trim().min(1, 'title em falta'),
  contentHtml: z.string().trim().min(1, 'contentHtml em falta'),
  durationMin: z.number().int('durationMin tem de ser inteiro').positive('durationMin tem de ser positivo').optional(),
});

const updateLessonSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    contentHtml: z.string().trim().min(1).optional(),
    durationMin: z.number().int('durationMin tem de ser inteiro').positive('durationMin tem de ser positivo').optional(),
  })
  .strict();

const ORDER_STATUSES = ['PENDING', 'PAID', 'FAILED', 'REFUNDED'];

const listOrdersQuerySchema = z
  .object({
    status: z.enum(ORDER_STATUSES).optional(),
    from: z.string().trim().min(1).optional(),
    to: z.string().trim().min(1).optional(),
  })
  .strict();

const statsQuerySchema = z
  .object({
    from: z.string().trim().min(1).optional(),
    to: z.string().trim().min(1).optional(),
  })
  .strict();

// Datas inválidas em `from`/`to` têm de dar 400, não rebentar 500 lá em
// baixo quando o Prisma recebe um Date inválido.
function parseDateParam(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, `${label} inválido`);
  }
  return date;
}

function buildCreatedAtFilter(from, to) {
  const filter = {};
  if (from) filter.gte = parseDateParam(from, 'from');
  if (to) filter.lte = parseDateParam(to, 'to');
  return filter;
}

// Prisma P2002 (unique constraint) devolve 409 com mensagem clara, em vez
// de rebentar como 500 — usado nos conflitos de `order` únicos por curso/módulo.
function isUniqueConstraintError(err) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

module.exports = function (env) {
  const router = express.Router();

  router.use(requireAuth(env), requireAdmin);

  router.post('/courses', async (req, res, next) => {
    try {
      const parsed = createCourseSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }
      const { slug, title, description, priceKz, coverUrl, category, type } = parsed.data;

      // sellerId nunca vem do body — vai sempre buscar o seller fixo "oaken".
      const seller = await prisma.seller.findUniqueOrThrow({ where: { slug: SELLER_SLUG } });

      const course = await prisma.course.create({
        data: {
          sellerId: seller.id,
          slug,
          title,
          description,
          priceKz,
          coverUrl,
          category,
          type,
          published: false,
        },
      });

      res.status(201).json({ course });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return next(new HttpError(409, 'Já existe um curso com este slug'));
      }
      next(err);
    }
  });

  router.patch('/courses/:id', async (req, res, next) => {
    try {
      const parsed = updateCourseSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }

      // slug e sellerId não entram aqui de propósito — não deixar mudar por
      // esta rota (partiria URLs já partilhadas / abriria brecha de vendedor).
      const course = await prisma.course.update({
        where: { id: req.params.id },
        data: parsed.data,
      });

      res.json({ course });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return next(new HttpError(404, 'Curso não encontrado'));
      }
      next(err);
    }
  });

  router.post('/courses/:id/modules', async (req, res, next) => {
    try {
      const parsed = createModuleSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }
      const { order, title } = parsed.data;

      const course = await prisma.course.findUnique({ where: { id: req.params.id } });
      if (!course) {
        return next(new HttpError(404, 'Curso não encontrado'));
      }

      const mod = await prisma.module.create({
        data: { courseId: course.id, order, title },
      });

      res.status(201).json({ module: mod });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return next(new HttpError(409, 'Já existe um módulo com este order neste curso'));
      }
      next(err);
    }
  });

  router.post('/modules/:id/lessons', async (req, res, next) => {
    try {
      const parsed = createLessonSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }
      const { order, title, contentHtml, durationMin } = parsed.data;

      const mod = await prisma.module.findUnique({ where: { id: req.params.id } });
      if (!mod) {
        return next(new HttpError(404, 'Módulo não encontrado'));
      }

      const lesson = await prisma.lesson.create({
        data: {
          moduleId: mod.id,
          order,
          title,
          contentHtml,
          ...(durationMin !== undefined ? { durationMin } : {}),
        },
      });

      res.status(201).json({ lesson });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return next(new HttpError(409, 'Já existe uma aula com este order neste módulo'));
      }
      next(err);
    }
  });

  router.patch('/lessons/:id', async (req, res, next) => {
    try {
      const parsed = updateLessonSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }

      const lesson = await prisma.lesson.update({
        where: { id: req.params.id },
        data: parsed.data,
      });

      res.json({ lesson });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return next(new HttpError(404, 'Aula não encontrada'));
      }
      next(err);
    }
  });

  // Lista TODOS os cursos do seller "oaken", incluindo rascunhos — ao
  // contrário de GET /api/courses (rota pública), que só mostra publicados.
  router.get('/courses', async (req, res, next) => {
    try {
      const seller = await prisma.seller.findUniqueOrThrow({ where: { slug: SELLER_SLUG } });

      const courses = await prisma.course.findMany({
        where: { sellerId: seller.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          slug: true,
          title: true,
          priceKz: true,
          published: true,
          coverUrl: true,
          category: true,
          type: true,
          createdAt: true,
          _count: { select: { orders: true, enrollments: true } },
        },
      });

      res.json({ courses });
    } catch (err) {
      next(err);
    }
  });

  router.get('/orders', async (req, res, next) => {
    try {
      const parsed = listOrdersQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Parâmetros inválidos'));
      }
      const { status, from, to } = parsed.data;
      const createdAtFilter = buildCreatedAtFilter(from, to);

      // sellerId nunca vem do cliente — fixo no seller "oaken", via
      // relação course.sellerId (Order não guarda sellerId directamente).
      const seller = await prisma.seller.findUniqueOrThrow({ where: { slug: SELLER_SLUG } });

      const orders = await prisma.order.findMany({
        where: {
          course: { sellerId: seller.id },
          ...(status ? { status } : {}),
          ...(Object.keys(createdAtFilter).length ? { createdAt: createdAtFilter } : {}),
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          createdAt: true,
          paidAt: true,
          status: true,
          amountKz: true,
          provider: true,
          course: { select: { title: true, slug: true } },
          user: { select: { name: true, email: true } },
        },
      });

      res.json({ orders });
    } catch (err) {
      next(err);
    }
  });

  router.get('/stats', async (req, res, next) => {
    try {
      const parsed = statsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Parâmetros inválidos'));
      }
      const { from, to } = parsed.data;
      const createdAtFilter = buildCreatedAtFilter(from, to);

      const seller = await prisma.seller.findUniqueOrThrow({ where: { slug: SELLER_SLUG } });

      const grouped = await prisma.order.groupBy({
        by: ['status'],
        where: {
          course: { sellerId: seller.id },
          ...(Object.keys(createdAtFilter).length ? { createdAt: createdAtFilter } : {}),
        },
        _sum: { amountKz: true },
        _count: { _all: true },
      });

      let approvedKz = 0;
      let approvedCount = 0;
      let pendingKz = 0;
      let pendingCount = 0;
      let cancelledKz = 0;
      let cancelledCount = 0;

      for (const group of grouped) {
        const kz = group._sum.amountKz || 0;
        const count = group._count._all;
        if (group.status === 'PAID') {
          approvedKz = kz;
          approvedCount = count;
        } else if (group.status === 'PENDING') {
          pendingKz = kz;
          pendingCount = count;
        } else {
          // FAILED e REFUNDED contam ambos como "canceladas".
          cancelledKz += kz;
          cancelledCount += count;
        }
      }

      // Nunca dividir por zero — sem encomendas PAID, o ticket médio é 0.
      const avgTicketKz = approvedCount > 0 ? Math.round(approvedKz / approvedCount) : 0;

      res.json({
        approvedKz,
        approvedCount,
        pendingKz,
        pendingCount,
        cancelledKz,
        cancelledCount,
        avgTicketKz,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

const express = require('express');
const { z } = require('zod');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../config/prisma');
const { HttpError } = require('../middleware/errorHandler');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const SELLER_SLUG = 'oaken';

const createCourseSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'slug só pode ter minúsculas, números e hífens'),
  title: z.string().trim().min(1, 'title em falta'),
  description: z.string().trim().min(1, 'description em falta'),
  priceKz: z.number().int('priceKz tem de ser inteiro').positive('priceKz tem de ser positivo'),
  coverUrl: z.string().url('coverUrl inválido').optional(),
});

const updateCourseSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    priceKz: z.number().int('priceKz tem de ser inteiro').positive('priceKz tem de ser positivo').optional(),
    coverUrl: z.string().url('coverUrl inválido').optional(),
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
      const { slug, title, description, priceKz, coverUrl } = parsed.data;

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

  return router;
};

const express = require('express');
const jwt = require('jsonwebtoken');
const { prisma } = require('../config/prisma');
const { HttpError } = require('../middleware/errorHandler');

const SELLER_SLUG = 'oaken';

// Campos públicos de um curso — nunca inclui contentHtml nem dados internos.
const PUBLIC_COURSE_SELECT = {
  id: true,
  slug: true,
  title: true,
  description: true,
  priceKz: true,
  coverUrl: true,
};

// Tenta decifrar um utilizador autenticado sem obrigar autenticação — a
// rota de detalhe do curso é pública, mas mostra mais dados a quem tem
// sessão válida e Enrollment.
function tryAuth(req, env) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, env.jwtSecret);
  } catch {
    return null;
  }
}

module.exports = function (env) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const courses = await prisma.course.findMany({
        where: {
          published: true,
          seller: { slug: SELLER_SLUG },
        },
        select: PUBLIC_COURSE_SELECT,
        orderBy: { createdAt: 'desc' },
      });
      res.json({ courses });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:slug', async (req, res, next) => {
    try {
      const course = await prisma.course.findUnique({
        where: { slug: req.params.slug },
        include: {
          seller: { select: { slug: true } },
          modules: {
            orderBy: { order: 'asc' },
            include: {
              lessons: {
                orderBy: { order: 'asc' },
                select: {
                  id: true,
                  order: true,
                  title: true,
                  durationMin: true,
                  // contentHtml excluído de propósito — só entra depois de
                  // confirmar Enrollment.
                },
              },
            },
          },
        },
      });

      if (!course || course.seller.slug !== SELLER_SLUG) {
        return next(new HttpError(404, 'Curso não encontrado'));
      }

      const user = tryAuth(req, env);

      // Curso não publicado só é visível a ADMIN.
      if (!course.published && user?.role !== 'ADMIN') {
        return next(new HttpError(404, 'Curso não encontrado'));
      }

      let enrolled = false;
      if (user) {
        const enrollment = await prisma.enrollment.findUnique({
          where: { userId_courseId: { userId: user.sub, courseId: course.id } },
        });
        enrolled = Boolean(enrollment);
      }

      const modules = course.modules.map((mod) => ({
        id: mod.id,
        order: mod.order,
        title: mod.title,
        lessons: mod.lessons.map((lesson) =>
          enrolled
            ? lesson
            : { id: lesson.id, order: lesson.order, title: lesson.title }
        ),
      }));

      res.json({
        course: {
          id: course.id,
          slug: course.slug,
          title: course.title,
          description: course.description,
          priceKz: course.priceKz,
          coverUrl: course.coverUrl,
          published: course.published,
          modules,
        },
        enrolled,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

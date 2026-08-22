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
          checkout: {
            include: { bumpCourse: { select: { id: true, slug: true, title: true, published: true } } },
          },
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
                  // contentHtml vem sempre da BD aqui — quem decide se
                  // chega ao cliente é o mapeamento abaixo, conforme
                  // `enrolled`. Excluí-lo do select fazia o conteúdo nunca
                  // chegar nem a quem já tinha pago.
                  contentHtml: true,
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

      // Só mostra o bump a quem ainda não tem o curso principal (não faz
      // sentido oferecer um upsell no checkout de quem já vai comprar) —
      // e só se o checkout estiver activo, com bump definido, e o curso do
      // bump ainda publicado (pode ter sido despublicado depois de
      // configurado como bump).
      const bumpOffer =
        !enrolled &&
        course.checkout?.active &&
        course.checkout.bumpCourseId &&
        course.checkout.bumpCourse?.published
          ? {
              course: {
                id: course.checkout.bumpCourse.id,
                slug: course.checkout.bumpCourse.slug,
                title: course.checkout.bumpCourse.title,
              },
              priceKz: course.checkout.bumpPriceKz,
              headline: course.checkout.bumpHeadline,
            }
          : null;

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
          bumpOffer,
        },
        enrolled,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

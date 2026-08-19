const express = require('express');
const { z } = require('zod');
const { prisma } = require('../config/prisma');
const { HttpError } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');
const { getProvider } = require('../services/payments');

const createOrderSchema = z.object({
  courseId: z.string().uuid('courseId inválido'),
  provider: z.string().trim().min(1, 'provider em falta'),
});

module.exports = function (env) {
  const router = express.Router();

  router.post('/', requireAuth(env), async (req, res, next) => {
    try {
      const parsed = createOrderSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }
      const { courseId, provider } = parsed.data;

      // getProvider valida o nome do provedor antes de tocar na BD — se for
      // desconhecido, falha cedo com 400.
      const paymentProvider = getProvider(provider);

      const course = await prisma.course.findUnique({ where: { id: courseId } });
      if (!course || !course.published) {
        return next(new HttpError(404, 'Curso não encontrado'));
      }

      const existingEnrollment = await prisma.enrollment.findUnique({
        where: { userId_courseId: { userId: req.user.sub, courseId: course.id } },
      });
      if (existingEnrollment) {
        return next(new HttpError(409, 'Já tem acesso a este curso'));
      }

      // O preço cobrado vem sempre do Course guardado na BD — nunca de um
      // valor enviado pelo cliente no body do pedido.
      const order = await prisma.order.create({
        data: {
          userId: req.user.sub,
          courseId: course.id,
          amountKz: course.priceKz,
          status: 'PENDING',
          provider,
        },
      });

      const charge = await paymentProvider.createCharge(order);

      const updatedOrder = await prisma.order.update({
        where: { id: order.id },
        data: { providerRef: charge.providerRef },
      });

      res.status(201).json({
        order: {
          id: updatedOrder.id,
          courseId: updatedOrder.courseId,
          amountKz: updatedOrder.amountKz,
          status: updatedOrder.status,
          provider: updatedOrder.provider,
          providerRef: updatedOrder.providerRef,
        },
        redirectUrl: charge.redirectUrl ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

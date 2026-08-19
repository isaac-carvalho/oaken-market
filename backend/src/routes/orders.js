const express = require('express');
const { z } = require('zod');
const { prisma } = require('../config/prisma');
const { HttpError } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');
const { getProvider } = require('../services/payments');

const createOrderSchema = z.object({
  courseId: z.string().uuid('courseId inválido'),
  provider: z.string().trim().min(1, 'provider em falta'),
  // affiliateRef é opcional e nunca deve conseguir rebentar a compra — por
  // isso aqui não se valida a forma como uuid (um valor mal formado não
  // deve dar 400, só é ignorado mais abaixo ao tentar encontrar o Affiliate).
  affiliateRef: z.string().trim().min(1).optional(),
  // UTM capturados na página do curso no momento da compra — opcionais,
  // sem regra especial de formato (só strings simples), mesma lógica do
  // affiliateRef: nunca podem rebentar a compra.
  utmSource: z.string().trim().min(1).optional(),
  utmMedium: z.string().trim().min(1).optional(),
  utmCampaign: z.string().trim().min(1).optional(),
});

module.exports = function (env) {
  const router = express.Router();

  router.post('/', requireAuth(env), async (req, res, next) => {
    try {
      const parsed = createOrderSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }
      const { courseId, provider, affiliateRef, utmSource, utmMedium, utmCampaign } = parsed.data;

      // getProvider valida o nome do provedor antes de tocar na BD — se for
      // desconhecido, falha cedo com 400.
      const paymentProvider = getProvider(provider);

      const course = await prisma.course.findUnique({ where: { id: courseId } });
      if (!course || !course.published) {
        return next(new HttpError(404, 'Curso não encontrado'));
      }

      // affiliateRef é opcional e pode vir adulterado (id de outro curso,
      // afiliação ainda PENDING, id inexistente ou até mal formado) — em
      // nenhum desses casos a compra falha, só não atribui comissão.
      let approvedAffiliate = null;
      if (affiliateRef) {
        try {
          const affiliate = await prisma.affiliate.findUnique({ where: { id: affiliateRef } });
          if (affiliate && affiliate.status === 'APPROVED' && affiliate.courseId === course.id) {
            approvedAffiliate = affiliate;
          }
        } catch {
          // id mal formado (ex: não é um uuid válido para a coluna) — ignora
          // silenciosamente, a compra continua normalmente sem comissão.
        }
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
          ...(utmSource ? { utmSource } : {}),
          ...(utmMedium ? { utmMedium } : {}),
          ...(utmCampaign ? { utmCampaign } : {}),
          ...(approvedAffiliate
            ? {
                affiliateId: approvedAffiliate.id,
                // Só informativo (o que o afiliado teria a receber) — não
                // paga nada, mesma regra do saldo em Financeiro.
                commissionKz: Math.round((course.priceKz * approvedAffiliate.commissionPct) / 100),
              }
            : {}),
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

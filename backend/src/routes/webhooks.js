const express = require('express');
const { prisma } = require('../config/prisma');
const { HttpError } = require('../middleware/errorHandler');
const { getProvider } = require('../services/payments');

module.exports = function (env) {
  const router = express.Router();

  // Endpoint público — chamado pelo provedor de pagamento, não pelo browser.
  router.post('/:provider', async (req, res, next) => {
    try {
      const paymentProvider = getProvider(req.params.provider);

      // Valida assinatura/segredo do pedido antes de confiar em nada do body.
      await paymentProvider.verifyWebhook(req);

      const result = await paymentProvider.parseWebhook(req);
      const { providerRef, status } = result;

      if (!providerRef) {
        return next(new HttpError(400, 'providerRef em falta no webhook'));
      }

      const order = await prisma.order.findFirst({
        where: { providerRef, provider: req.params.provider },
      });
      if (!order) {
        return next(new HttpError(404, 'Encomenda não encontrada para este webhook'));
      }

      if (status !== 'PAID') {
        // Provedor reportou falha — regista sem criar matrícula.
        if (order.status !== 'PAID') {
          await prisma.order.update({
            where: { id: order.id },
            data: { status: 'FAILED' },
          });
        }
        return res.status(200).json({ received: true });
      }

      // Idempotência: se a encomenda já está PAID (webhook duplicado),
      // responde 200 sem repetir o update nem criar um segundo Enrollment —
      // a constraint única Enrollment(userId, courseId) e a checagem abaixo
      // garantem que nunca há duplicação mesmo sob corrida.
      if (order.status === 'PAID') {
        return res.status(200).json({ received: true, alreadyProcessed: true });
      }

      await prisma.$transaction(async (tx) => {
        // Reconfirma dentro da transacção para evitar corrida entre dois
        // webhooks concorrentes (compare-and-set via updateMany).
        const updateResult = await tx.order.updateMany({
          where: { id: order.id, status: { not: 'PAID' } },
          data: { status: 'PAID', paidAt: new Date() },
        });

        // Se updateResult.count === 0, outro webhook já marcou a encomenda
        // como PAID entretanto — não cria Enrollment duplicado.
        if (updateResult.count === 0) return;

        await tx.enrollment.upsert({
          where: { userId_courseId: { userId: order.userId, courseId: order.courseId } },
          update: {},
          create: {
            userId: order.userId,
            courseId: order.courseId,
            orderId: order.id,
          },
        });
      });

      res.status(200).json({ received: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

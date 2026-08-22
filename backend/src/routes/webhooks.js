const express = require('express');
const crypto = require('crypto');
const { prisma } = require('../config/prisma');
const { HttpError } = require('../middleware/errorHandler');
const { getProvider } = require('../services/payments');

const WEBHOOK_TIMEOUT_MS = 5000;

// Dispara o evento `order.paid` para os endpoints de webhook registados do
// seller "oaken". Corre DEPOIS da Order já estar confirmada como PAID na
// BD — uma falha aqui (URL fora do ar, timeout, DNS) nunca pode voltar a
// afetar a compra em si, por isso cada chamada é isolada no seu próprio
// try/catch e o erro só é registado (console.error), nunca propagado.
async function dispatchOrderPaidWebhooks(order) {
  let endpoints;
  try {
    endpoints = await prisma.webhookEndpoint.findMany({
      where: { active: true, seller: { slug: 'oaken' } },
    });
  } catch (err) {
    console.error('[webhooks] falha ao buscar endpoints registados:', err);
    return;
  }

  if (endpoints.length === 0) return;

  const payload = {
    event: 'order.paid',
    orderId: order.id,
    courseId: order.courseId,
    amountKz: order.amountKz,
    commissionKz: order.commissionKz ?? null,
    bumpCourseId: order.bumpCourseId ?? null,
    bumpAmountKz: order.bumpAmountKz ?? null,
    paidAt: order.paidAt,
  };
  const body = JSON.stringify(payload);

  await Promise.all(
    endpoints.map(async (endpoint) => {
      const signature = crypto.createHmac('sha256', endpoint.secret).update(body).digest('hex');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
      try {
        await fetch(endpoint.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Oaken-Signature': signature,
          },
          body,
          signal: controller.signal,
        });
      } catch (err) {
        // Timeout, DNS, conexão recusada, etc. — nunca deixar rebentar a
        // confirmação do pagamento, que já aconteceu antes desta chamada.
        console.error(`[webhooks] falha ao chamar webhook ${endpoint.id} (${endpoint.url}):`, err);
      } finally {
        clearTimeout(timeout);
      }
    })
  );
}

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

      const paidAt = new Date();
      let justPaid = false;

      await prisma.$transaction(async (tx) => {
        // Reconfirma dentro da transacção para evitar corrida entre dois
        // webhooks concorrentes (compare-and-set via updateMany).
        const updateResult = await tx.order.updateMany({
          where: { id: order.id, status: { not: 'PAID' } },
          data: { status: 'PAID', paidAt },
        });

        // Se updateResult.count === 0, outro webhook já marcou a encomenda
        // como PAID entretanto — não cria Enrollment duplicado.
        if (updateResult.count === 0) return;

        justPaid = true;

        await tx.enrollment.upsert({
          where: { userId_courseId: { userId: order.userId, courseId: order.courseId } },
          update: {},
          create: {
            userId: order.userId,
            courseId: order.courseId,
            orderId: order.id,
          },
        });

        // Order bump: se a encomenda incluiu um segundo curso, matricula
        // também nesse — mesma Order, 2 Enrollment (@@unique(userId,
        // courseId) continua a garantir que nunca duplica).
        if (order.bumpCourseId) {
          await tx.enrollment.upsert({
            where: { userId_courseId: { userId: order.userId, courseId: order.bumpCourseId } },
            update: {},
            create: {
              userId: order.userId,
              courseId: order.bumpCourseId,
              orderId: order.id,
            },
          });
        }
      });

      // A Order já está confirmada como PAID na BD neste ponto — o disparo
      // dos webhooks de saída corre depois, fora da transacção, e nunca é
      // esperado antes de responder ao provedor de pagamento. Só dispara na
      // transição real para PAID (não em webhooks duplicados/já processados).
      if (justPaid) {
        dispatchOrderPaidWebhooks({ ...order, status: 'PAID', paidAt }).catch((err) => {
          console.error('[webhooks] erro inesperado ao disparar webhooks de saída:', err);
        });
      }

      res.status(200).json({ received: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

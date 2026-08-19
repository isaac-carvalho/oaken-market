/**
 * Provedor "manual" — para desenvolvimento e testes antes da integração
 * real (Multicaixa Express / Unitel Money) estar ligada.
 * Marca a encomenda como paga de imediato. NUNCA usar em produção real
 * com dinheiro real — serve só para testar o fluxo de compra ponta a ponta.
 */

async function createCharge(order) {
  return { providerRef: `manual-${order.id}`, redirectUrl: null };
}

async function verifyWebhook() {
  // sem assinatura a validar neste provedor de teste
  return true;
}

async function parseWebhook(req) {
  return { providerRef: req.body.providerRef, status: 'PAID' };
}

module.exports = { createCharge, verifyWebhook, parseWebhook };

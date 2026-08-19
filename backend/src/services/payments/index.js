/**
 * Registo de provedores de pagamento.
 *
 * Cada provedor implementa:
 *   - createCharge(order): inicia o pagamento, devolve { redirectUrl?, providerRef }
 *   - verifyWebhook(req): valida a assinatura/segredo do pedido recebido, lança erro se inválida
 *   - parseWebhook(req): devolve { providerRef, status: 'PAID'|'FAILED' } a partir do payload
 *
 * Para ligar o Multicaixa Express / Unitel Money, criar
 * `./multicaixaProvider.js` e `./unitelProvider.js` com esta mesma forma
 * e registar abaixo — nada no resto do backend precisa de mudar.
 */

const manualProvider = require('./manualProvider');

const PROVIDERS = {
  manual: manualProvider,
};

function getProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) {
    const err = new Error(`Provedor de pagamento desconhecido: ${name}`);
    err.status = 400;
    throw err;
  }
  return provider;
}

module.exports = { getProvider, PROVIDERS };

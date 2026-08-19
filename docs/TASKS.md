# Tarefas — Oaken Market (MVP)

Fluxo de trabalho: júnior implementa uma tarefa completa, sénior (revisão
independente) valida contra os critérios de aceitação abaixo. Só quando o
sénior aprova é que se passa à tarefa seguinte.

Stack: Node.js + Express + Prisma (Postgres via Supabase) + JWT + bcrypt +
Zod + Helmet. Schema já definido em `backend/prisma/schema.prisma`. Rotas
stub em `backend/src/routes/*.js` — substituir pela implementação real,
sem mudar a assinatura `module.exports = function (env) { ... return router }`.

Pagamento: o provedor real (Multicaixa Express / Unitel Money) está a ser
tratado à parte por outra pessoa. O backend só precisa de respeitar a
abstração em `backend/src/services/payments/` — nunca assumir detalhes de
um provedor específico dentro das rotas.

---

## Tarefa 1 — Autenticação (`backend/src/routes/auth.js`)

- `POST /api/auth/signup` — body `{ email, password, name }` validado com Zod
  (email válido, password mín. 8 caracteres com 1 número e 1 maiúscula, name
  não vazio). Hash da password com bcrypt (custo 12). Cria `User` com
  `role: BUYER`. Devolve `{ token, user: { id, email, name, role } }` — nunca
  devolver `passwordHash`.
- `POST /api/auth/login` — body `{ email, password }`. Compara hash com
  bcrypt. Erros de credencial inválida devem ser genéricos ("email ou senha
  inválidos"), nunca dizer qual dos dois está errado. Devolve o mesmo
  formato do signup.
- Token JWT assinado com `env.jwtSecret`, payload `{ sub: user.id, role }`,
  validade 7 dias.
- `GET /api/auth/me` — atrás de `requireAuth(env)` (já existe em
  `middleware/auth.js`), devolve o utilizador autenticado.

**Critérios de aceitação (sénior valida):**
- Nunca aceita password fraca nem email malformado (testar com Zod a falhar).
- `passwordHash` nunca aparece em nenhuma resposta JSON.
- Emails duplicados devolvem 409, não 500.
- Rate limit de `/api/auth/*` já está aplicado em `index.js` — não duplicar.
- `npx prisma migrate dev` corre sem erro com o schema actual.

---

## Tarefa 2 — Cursos e Encomendas (`backend/src/routes/courses.js`, `orders.js`, `webhooks.js`)

- `GET /api/courses` — lista cursos `published: true` do seller "oaken"
  (público, sem autenticação). Campos: id, slug, title, description,
  priceKz, coverUrl. Nunca listar cursos não publicados a quem não é ADMIN.
- `GET /api/courses/:slug` — detalhe do curso com módulos e aulas *só se*
  o utilizador autenticado tiver `Enrollment` para esse curso; caso
  contrário devolve só metadados + títulos dos módulos (sem `contentHtml`
  das aulas — isso é o produto pago).
- `POST /api/orders` — atrás de `requireAuth(env)`. Body `{ courseId,
  provider }`. Cria `Order` com `status: PENDING`, chama
  `getProvider(provider).createCharge(order)` (ver
  `services/payments/index.js`), guarda `providerRef`, devolve o resultado
  do provedor ao cliente.
- `POST /api/webhooks/:provider` — endpoint público (chamado pelo provedor
  de pagamento, não pelo browser). Chama `verifyWebhook` e depois
  `parseWebhook` do provedor correspondente. Se `status === 'PAID'`: marca
  a `Order` como `PAID`, define `paidAt`, e cria o `Enrollment`
  correspondente numa transacção Prisma (`prisma.$transaction`) — nunca os
  dois passos separados, para não ficar pago sem matrícula se cair a meio.
  Idempotente: se o webhook chegar duplicado (mesma `providerRef` já paga),
  responde 200 sem duplicar o Enrollment.

**Critérios de aceitação (sénior valida):**
- `contentHtml` das aulas nunca vaza para quem não comprou o curso.
- Webhook duplicado não cria duas matrículas nem dois emails de
  confirmação (testar chamando duas vezes seguidas).
- Preço vem sempre do `Course` na base de dados, nunca do body do pedido
  do cliente (para não deixar o comprador escolher o preço).
- Nenhuma rota de pagamento assume Multicaixa/Unitel directamente — só usa
  `getProvider()`.

---

## Por fazer depois do MVP (não começar sem falar com o dono)

- Painel do vendedor (permitir a outros criadores publicar cursos)
- Frontend de loja + checkout
- Emails transacionais (confirmação de compra)
- Provedor real Multicaixa Express / Unitel Money (fica a cargo de quem já
  está a tratar da API)

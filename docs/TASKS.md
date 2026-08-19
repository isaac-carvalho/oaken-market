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

## Tarefa 1 — Autenticação (`backend/src/routes/auth.js`) ✅ concluída, revista pelo sénior

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

## Tarefa 2 — Cursos e Encomendas (`backend/src/routes/courses.js`, `orders.js`, `webhooks.js`) ✅ concluída, revista pelo sénior

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

## Tarefa 3 — Administração de conteúdo (`backend/src/routes/admin.js`) ✅ concluída, revista pelo sénior

Sem isto não há forma de a Oaken publicar um curso — falta a peça que
liga o schema (Course/Module/Lesson) a alguém a escrever conteúdo.
Rotas todas atrás de `requireAuth(env)` + `requireAdmin` (já existem em
`middleware/auth.js`).

- `POST /api/admin/courses` — cria curso. Body: `{ slug, title,
  description, priceKz, coverUrl? }`. `slug` só `[a-z0-9-]`, único (Zod +
  regex). `priceKz` inteiro positivo. `sellerId` nunca vem do body — vai
  sempre buscar o seller "oaken" (`prisma.seller.findUniqueOrThrow({where:
  {slug: 'oaken'}})`), como fizeram nas rotas de cursos/encomendas.
  `published` começa sempre `false` (curso nasce em rascunho).
- `PATCH /api/admin/courses/:id` — actualiza campos do curso (title,
  description, priceKz, coverUrl, published). Não deixar mudar `slug`
  nem `sellerId` por aqui (evita partir URLs já partilhadas).
- `POST /api/admin/courses/:id/modules` — cria módulo. Body: `{ order,
  title }`. `order` tem de ser único dentro do curso (o schema já tem
  `@@unique([courseId, order])` — apanhar o erro P2002 do Prisma e devolver
  409 com mensagem clara, não deixar rebentar como 500).
- `POST /api/admin/modules/:id/lessons` — cria aula. Body: `{ order,
  title, contentHtml, durationMin? }`. Mesma lógica de `order` único
  (`@@unique([moduleId, order])`) e mesmo tratamento de P2002.
- `PATCH /api/admin/lessons/:id` — actualiza `title`/`contentHtml`/
  `durationMin` de uma aula já criada (para corrigir texto sem recriar).

**Critérios de aceitação (sénior valida):**
- Nenhuma rota aceita `sellerId` do body — vem sempre do seller "oaken"
  fixo, para não abrir brecha de um curso aparecer sob outro vendedor.
- `slug` validado com regex antes de ir à BD (nada de espaços, maiúsculas
  ou acentos — vai para o URL).
- Conflito de `order` dentro do mesmo curso/módulo devolve 409, não 500.
- Um pedido sem token, ou com token de utilizador BUYER, recebe 401/403 —
  testar mentalmente os dois casos e confirmar no código que
  `requireAuth` + `requireAdmin` estão mesmo montados antes do handler.
- Ligar a rota em `src/index.js`: `app.use('/api/admin',
  require('./routes/admin')(env))` — hoje esse `require` ainda não existe
  lá, tens de o adicionar.

## Tarefa 4 — Frontend: loja + checkout (`frontend/`) ✅ concluída, revista pelo sénior

HTML/CSS/JS puro (sem framework, sem build step) — mesmo estilo do resto
dos projectos Oaken (ver `oaken-cursos/*/index.html` como referência de
visual: navy `#0B1F3A` + laranja `#FF6B00`, cards, fonte Segoe UI). Base
da API: `http://localhost:5000` (backend já a correr).

Ficheiros:
- `frontend/index.html` — lista cursos publicados (`GET /api/courses`).
  Card por curso: título, descrição, `priceKz` formatado (ex: "50 000 Kz"),
  botão que leva a `curso.html?slug=...`.
- `frontend/curso.html` — detalhe do curso (`GET /api/courses/:slug`,
  manda o token no header `Authorization` se existir em `localStorage`).
  Mostra módulos/aulas; se `enrolled:false`, aulas aparecem só com título
  (cadeado); se `enrolled:true`, mostra `contentHtml` de cada aula. Botão
  "Comprar" chama `POST /api/orders` com `{courseId, provider:"manual"}`
  (só há o provedor manual por agora — o real ainda não está ligado).
  Depois de criar a encomenda, chama automaticamente
  `POST /api/webhooks/manual` com o `providerRef` devolvido, para simular
  a confirmação de pagamento (isto é só para testar o fluxo agora — quando
  o provedor real entrar, este passo desaparece e o pagamento confirma-se
  sozinho). Depois disso, recarrega o curso para mostrar o conteúdo.
- `frontend/login.html` — formulário de login/signup (toggle entre os
  dois). Guarda `token` e `user` em `localStorage` depois de
  `POST /api/auth/login` ou `/signup`. Redireciona para `index.html`.
- `frontend/app.js` (partilhado) — funções: `apiFetch(path, opts)` (junta
  `Authorization: Bearer <token>` do localStorage automaticamente se
  existir), `formatKz(n)`, `logout()`, `renderHeader()` (mostra nome do
  utilizador + botão sair, ou botão entrar).
- `frontend/style.css` (partilhado, extraído dos 3 HTML).

**Critérios de aceitação:**
- Nenhum HTML mostra `contentHtml` sem `enrolled:true` vindo da API —
  confiar sempre na resposta da API, nunca esconder só com CSS/JS no
  cliente (isso não é segurança nenhuma, o backend já protege — o
  frontend só precisa de respeitar o que a API devolve).
- `priceKz` sempre formatado como Kwanza (ex: `50000` → `"50 000 Kz"`).
- Erros da API (400/401/404/409) aparecem como mensagem legível na
  página, nunca um alert cru de JSON.
- Funciona abrindo os ficheiros num server estático simples (ex:
  `npx serve frontend` ou `python -m http.server` dentro de `frontend/`)
  com o backend a correr em paralelo em `localhost:5000`.

## Notas da revisão do sénior

- **Auth:** corrigido um side-channel de tempo no login — quando o email
  não existe, o código antigo saltava o `bcrypt.compare` e respondia mais
  rápido do que quando a senha estava errada, o que permitia adivinhar
  emails registados pela diferença de tempo. Agora compara sempre contra
  um hash (real ou "dummy"), timing igual nos dois casos.
- **Cursos/Encomendas:** aprovado sem alterações — idempotência do webhook
  bem feita (compare-and-set dentro da `$transaction`, não só um `if`
  antes dela), preço sempre lido do `Course` na BD, `contentHtml` protegido
  atrás de `Enrollment`.
- Confirmando a dúvida do júnior da Tarefa 2: `req.user.sub` é mesmo o
  `userId` (payload do JWT em `auth.js` é `{ sub: user.id, role }`).
- Confirmando a outra dúvida: 404 (não 403) em curso não publicado está
  correto — não revelar a um estranho que um slug existe é a escolha certa.

### Backlog não-bloqueante (não impede seguir para o resto do MVP)

- Índice único em `Order(provider, providerRef)` — hoje o webhook encontra
  a encomenda por `findFirst`, funciona mas não tem a BD a garantir a
  unicidade.
- Impedir criar uma segunda `Order` para um curso que o utilizador já tem
  `Enrollment` — hoje é possível pagar duas vezes pelo mesmo curso.

---

## Por fazer depois do MVP (não começar sem falar com o dono)

- Painel do vendedor (permitir a outros criadores publicar cursos)
- Frontend de loja + checkout
- Emails transacionais (confirmação de compra)
- Provedor real Multicaixa Express / Unitel Money (fica a cargo de quem já
  está a tratar da API)

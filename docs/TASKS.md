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

## Tarefa 5 — Redesign visual da loja (Hotmart-like) ✅ concluída, revista pelo sénior

Objectivo: a loja (`frontend/`) tem de parecer uma plataforma de venda de
cursos moderna e profissional (referência: Hotmart, Kiwify) — não uma
página de curso isolada. Continua HTML/CSS/JS puro, sem framework, sem
build step. Não mexer na lógica de `app.js` (`apiFetch`, `formatKz`,
`logout`) nem no contrato com a API — só visual/estrutura.

**Linguagem visual:**
- Paleta: manter navy `#0B1F3A` + laranja `#FF6B00` (marca Oaken, usada em
  todos os outros produtos), mas com mais respiração, sombras suaves,
  cantos arredondados (12-20px), gradientes subtis no hero.
- Tipografia: Segoe UI / system-ui, hierarquia clara (hero grande e
  ousado, corpo legível).
- `index.html`: hero de topo (título + subtítulo + CTA), depois grid de
  cursos em cards com imagem de capa (`coverUrl`), título, descrição
  curta, preço em destaque, badge de módulos/carga horária se a API
  devolver isso. Cards com hover (leve elevação/zoom).
- `curso.html`: banner com a capa do curso, título grande, descrição,
  caixa de compra fixa/destacada (estilo "sidebar de produto" da
  Hotmart — preço grande, botão de compra grande, o que está incluído).
  Lista de módulos/aulas abaixo, com cadeados visuais claros em aulas
  bloqueadas.
- `login.html`: cartão centrado, visual consistente com o resto.
- Header fixo em todas as páginas: logo, e à direita nome/sair OU botão
  entrar (lógica já existe em `renderHeader()`, só o estilo muda).

**Regra de honestidade (importante):** não inventar prova social falsa —
nada de "1000+ alunos", estrelas de avaliação, ou depoimentos fabricados.
Se quiseres um elemento de confiança, usa algo verdadeiro e genérico
("Certificado por módulo", "Conteúdo actualizado", "Suporte via
WhatsApp") — nunca um número ou testemunho inventado.

**Critérios de aceitação:**
- `apiFetch`, `formatKz`, `logout`, `renderHeader`, `showError`,
  `clearError` em `app.js` continuam com a mesma assinatura — as 3
  páginas continuam a chamá-las como antes.
- Nenhum dado falso/inventado (contadores, avaliações, depoimentos).
- Responsivo: grid de cursos quebra para 1 coluna em ecrã estreito
  (usa `@media` como o resto dos projectos Oaken).
- `contentHtml` continua só visível quando a API devolve `enrolled:true`
  — o redesign não pode alterar essa lógica em `curso.html`.

## Tarefa 6 — Tema escuro + acabamento premium na loja ✅ concluída, revista pelo sénior

Objectivo: dar à loja (`frontend/`) um acabamento "premium" tipo SaaS
moderno (referência que o dono mandou: Kursinha — fundo quase preto,
cards com brilho/glow sutil, gradientes discretos), com alternância
claro/escuro. Continua HTML/CSS/JS puro, sem framework. Não mexer na
lógica de `app.js` além do necessário para o toggle de tema.

**Sistema de tema:**
- CSS custom properties em `:root` para todas as cores (já existem
  algumas — auditar e garantir que TODA cor do `style.css` vem de uma
  variável, nenhuma hardcoded).
- `[data-theme="dark"]` no `<html>` redefine essas variáveis para a
  paleta escura. Base escura: fundo quase preto (`#0a0a0f` / `#0d1117`
  estilo), cards em cinza-azulado escuro com borda subtil
  (`rgba(255,255,255,.08)`), texto quase branco. Mantém laranja `#FF6B00`
  como accent em ambos os temas (é a cor da marca).
- Botão de alternância no header (ícone lua/sol), salva a escolha em
  `localStorage` (`theme`), aplica ao carregar a página em todas as 3
  páginas (`index.html`, `curso.html`, `login.html`) antes do primeiro
  paint se possível (evita "flash" de tema errado).
- Adiciona a função `initTheme()` a `app.js` (chamada no topo de cada
  página, antes de `renderHeader()`), e um `toggleTheme()` ligado ao
  botão.

**Acabamento premium (ambos os temas):**
- Cards com sombra mais profunda + leve glow na borda ao hover (usar
  `box-shadow` com a cor de accent a baixa opacidade).
- Botões primários com gradiente sutil em vez de cor sólida chapada.
- Micro-transições (`transition: all .2s ease`) em hovers/estados.
- Tipografia com mais peso nos títulos (`font-weight:800`), espaçamento
  generoso.

**Critérios de aceitação:**
- Toggle funciona nas 3 páginas, estado persiste ao navegar entre elas
  (localStorage).
- Nenhuma cor hardcoded fora das variáveis CSS (facilita manter os dois
  temas sincronizados).
- Tema escuro tem contraste legível (texto sobre fundo escuro, nunca
  cinza-escuro sobre preto).
- `apiFetch`, `formatKz`, `logout`, `renderHeader`, `showError`,
  `clearError`, e a lógica de `enrolled`/`contentHtml` continuam
  intactas — só adiciona `initTheme`/`toggleTheme`, não remove nada.

## Tarefa 7 — Backend do painel de produtor: listar cursos (com rascunhos) e encomendas ✅ concluída, revista pelo sénior

Sem isto o painel de produtor não tem dados reais para mostrar. Rotas
novas, todas atrás de `requireAuth(env)` + `requireAdmin` (mesmo padrão
de `admin.js`).

- `GET /api/admin/courses` — lista TODOS os cursos do seller "oaken"
  (publicados e rascunho, ao contrário de `GET /api/courses` que só
  mostra publicados). Campos: id, slug, title, priceKz, published,
  coverUrl, createdAt, e a contagem de `_count: { orders, enrollments }`
  (usar `prisma.course.findMany({ include: { _count: { select: {
  enrollments: true } } } })` — para "vendas aprovadas" por curso).
- `GET /api/admin/orders` — lista encomendas do seller "oaken", mais
  recentes primeiro. Cada item: id, createdAt, paidAt, status, amountKz,
  provider, course (`{ title, slug }`), user (`{ name, email }`). Aceita
  query params opcionais `status` (PENDING/PAID/FAILED/REFUNDED) e
  `from`/`to` (datas ISO, filtra por `createdAt`).
- `GET /api/admin/stats` — resumo para o dashboard: `{ approvedKz,
  approvedCount, pendingKz, pendingCount, cancelledKz, cancelledCount,
  avgTicketKz }`, calculado a partir de `Order` (PAID = aprovadas,
  PENDING = pendentes, FAILED/REFUNDED = canceladas). Aceita os mesmos
  `from`/`to` do endpoint acima.

**Critérios de aceitação:**
- `GET /api/admin/courses` mostra cursos rascunho (`published:false`) —
  diferente da rota pública, que nunca mostra isso a quem não é ADMIN
  (já implementado em `courses.js`, não mexer lá).
- Nenhuma rota nova aceita filtro de `sellerId` do cliente — sempre fixo
  no seller "oaken", igual ao resto de `admin.js`.
- `avgTicketKz` calcula-se só sobre encomendas PAID (dividir soma por
  contagem, nunca dividir por zero — devolver 0 se não houver nenhuma).
- Datas inválidas em `from`/`to` devolvem 400, não rebentam 500.

## Tarefa 8 — Painel de produtor: Dashboard, Produtos, Vendas ✅ concluída, revista pelo sénior

Nova área em `frontend/admin/` (pasta separada da loja pública) — painel
que só o dono usa para gerir os cursos. Referência visual: os
screenshots do Kursinha que o dono mandou (sidebar fixa à esquerda com
ícones, cards de estatística no topo, tabela de vendas com filtros).
Reaproveita o sistema de tema claro/escuro e `apiFetch`/`formatKz`/etc.
de `frontend/app.js` (copiar esse ficheiro para `frontend/admin/` ou
apontar para ele via `<script src="../app.js">` — o que for mais simples
sem duplicar lógica).

Depende da Tarefa 7 — usa `GET /api/admin/courses`, `/orders`, `/stats`
(lê a spec lá para os campos exactos). Se a Tarefa 7 ainda não estiver
pronta quando começares, constrói contra o contrato descrito nela na
mesma — os campos não vão mudar.

**Páginas:**
- `frontend/admin/index.html` — Dashboard: cards de estatística (vendas
  aprovadas/pendentes/canceladas em Kz + contagem, ticket médio), vindos
  de `GET /api/admin/stats`.
- `frontend/admin/produtos.html` — lista de cursos (`GET
  /api/admin/courses`), com badge "Publicado"/"Rascunho". Botão "Criar
  curso" abre um modal (Nome=title, Preço=priceKz, Descrição=description,
  URL da capa=coverUrl — sem upload de ficheiro, é só um campo de URL por
  agora) que chama `POST /api/admin/courses`. Botão em cada curso pra
  publicar/despublicar (`PATCH /api/admin/courses/:id` com
  `{published: true/false}`).
- `frontend/admin/vendas.html` — tabela de encomendas (`GET
  /api/admin/orders`), colunas: data, curso, cliente, valor, status.
  Filtro simples por status (dropdown: Todas/Aprovadas/Pendentes/
  Canceladas) — filtra no cliente ou manda `?status=` para a API, como
  preferires.
- Sidebar fixa comum às 3 páginas: Dashboard, Produtos, Vendas (as 3
  reais) + Afiliados, Financeiro, Integrações, Ranking **marcados "Em
  breve"** (visíveis mas sem link/desabilitados, com badge) — essas
  quatro precisam de sistemas que ainda não existem (carteira/saque,
  afiliados, webhooks, gamificação) e não vão ser inventadas com dados
  falsos. Login simples: reaproveita `login.html` da loja, mas só deixa
  entrar no painel quem é ADMIN (checar `user.role` guardado no
  localStorage; se não for ADMIN, mostra mensagem e não entra).

**Regra de honestidade (igual à Tarefa 5):** nada de números de vendas
inventados, saldo fictício, ou afiliados fantasma nas páginas "Em breve"
— são só placeholders visuais dizendo que a funcionalidade ainda não
existe.

**Critérios de aceitação:**
- As 3 páginas reais mostram dados reais da API, nunca mockados.
- Páginas "Em breve" claramente marcadas como tal, sem fingir ter dados.
- Só ADMIN acede ao painel — BUYER é bloqueado com mensagem clara.
- Reaproveita `apiFetch`/`formatKz`/tema de `app.js`, não duplica essa
  lógica.

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

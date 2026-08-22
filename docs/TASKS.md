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

## Tarefa 9 — Dashboard: filtro de período + checklist "Próximos passos" ✅ concluída, revista pelo sénior

Referência real (dono navegou no Hotmart de verdade): filtro de período
acima dos cards de estatística, e um checklist de próximos passos
("Editar produto", "Criar mais um produto", "Acessar área de membros").
Copiar a ideia, não os dados nem a cor.

**Filtro de período** (`frontend/admin/index.html`):
- Botões: Hoje / 7 dias / 30 dias / Este ano / Tudo (parecido com o que
  já existe em `oaken-cursos` se quiseres olhar o padrão de UI usado lá).
  "30 dias" activo por omissão.
- Ao mudar, recalcula `from`/`to` (ISO) e chama de novo `GET
  /api/admin/stats?from=...&to=...` (o endpoint já aceita esses params,
  ver Tarefa 7 em cima) — nada de filtrar no cliente, manda para a API.
- "Tudo" = não manda `from`/`to`.

**Checklist "Próximos passos"** (mesma página, card novo abaixo dos
stats): compara com dados reais já disponíveis via `GET
/api/admin/courses` (chamar essa rota também no dashboard):
- ✅ "Criar o primeiro curso" — concluído se `courses.length > 0`.
- ✅ "Publicar um curso" — concluído se algum `course.published === true`.
- ⬜/✅ "Primeira venda" — concluído se `stats.approvedCount > 0`.
Cada item concluído fica visualmente diferente (check verde) dos por
fazer. Item não concluído tem um link para a página relevante
(produtos.html para os dois primeiros).

**Regra de honestidade:** nada de percentagem de "conquista" inventada
nem de gamificação tipo "níveis" — é só um checklist de 3 itens reais,
sem enfeite fantasioso.

**Critérios de aceitação:**
- Filtro realmente manda `from`/`to` para a API, não filtra em JS.
- Checklist reflecte dados reais (cursos/publicação/vendas), nunca
  hardcoded.
- Não duplica `apiFetch`/`formatKz` — reaproveita de `app.js`.
- `node --check` limpo em qualquer JS novo.

## Tarefa 10 — Financeiro (carteira), saldo real (0 até haver pagamento real) ✅ concluída, revista pelo sénior

Página nova `frontend/admin/financeiro.html`, sai de "Em breve" na
sidebar (`admin.js`, `ADMIN_NAV_ITEMS` — item `financeiro` passa a ter
`href: 'financeiro.html', soon: false`).

**Regra central (é o motivo desta tarefa existir):** o saldo tem de vir
de dinheiro real, nunca do provedor `manual` (esse é só para testar o
fluxo de compra, nunca moveu dinheiro nenhum — ver
`backend/src/services/payments/manualProvider.js`). Como hoje só existe
o provedor manual, o saldo disponível vai dar **0 Kz**, e está certo
estar assim — não é um placeholder, é o resultado real de excluir
vendas de teste do dinheiro de verdade. Quando o provedor real
(Multicaixa/Unitel) entrar, o saldo passa a reflectir vendas de verdade
automaticamente, sem mexer em nada.

**Backend — `GET /api/admin/wallet`** (adicionar a `admin.js`, mesmo
padrão das outras rotas, atrás de `requireAuth(env)` + `requireAdmin`):
```
{
  availableKz: <soma de Order.amountKz onde status=PAID e provider != 'manual'>,
  pendingKz:   <soma de Order.amountKz onde status=PENDING e provider != 'manual'>,
  totalKz:     availableKz + pendingKz
}
```
Sem `from`/`to` — é o saldo actual, não um relatório por período.

**Frontend (`frontend/admin/financeiro.html`)**, mesmo layout de
sidebar/tema das outras páginas do painel:
- Card "Saldo": Disponível / Pendente / Total (Kz), vindo de
  `GET /api/admin/wallet`.
- Aviso visível, sempre que `availableKz === 0`: "O saldo só conta
  pagamentos confirmados por um provedor real. Ainda não há nenhum
  ligado — por isso o saldo está a zero." (não esconder isto, é
  informação importante, não um erro).
- Botão "Solicitar saque" sempre desactivado por agora (`disabled`),
  com texto "Disponível quando o pagamento real estiver ligado" —
  nunca simular um pedido de saque que não existe.
- Nenhum histórico de saques inventado — mostrar directamente "Sem
  saques registados" (não há sistema de saque nenhum ainda, não faz
  sentido fingir uma lista vazia "a carregar").

**Critérios de aceitação:**
- `manual` nunca entra no cálculo do saldo — testar mentalmente com a
  compra real que já existe na BD (provider "manual", 299 000 Kz): não
  pode aparecer no saldo.
- Botão de saque nunca funcional, sempre claramente desactivado com o
  motivo.
- Reaproveita `apiFetch`/`formatKz`/`initAdminPage` — não duplica nada
  de `app.js`/`admin.js`.
- `node --check` limpo.

## Tarefa 11 — Backend de Afiliados ✅ concluída, revista pelo sénior

Schema já migrado (`Affiliate`, `Order.affiliateId`, `Order.commissionKz`
— ver `backend/prisma/schema.prisma`). Rotas novas.

**Lado do afiliado (`backend/src/routes/affiliates.js`, ficheiro novo,
montar em `src/index.js` como `app.use('/api/affiliates',
require('./routes/affiliates')(env));`)** — atrás de `requireAuth(env)`:
- `POST /api/affiliates` — body `{ courseId }`. Cria `Affiliate` com
  `status: PENDING` para o utilizador autenticado + esse curso. Erro 409
  se já existir pedido para esse par utilizador/curso (constraint
  `@@unique([userId, courseId])` já existe — apanhar P2002). 404 se o
  curso não existir ou não estiver publicado.
- `GET /api/affiliates/me` — lista as afiliações do próprio utilizador
  autenticado (todas, qualquer status), com `course: {title, slug}`.

**Lado do admin (adicionar a `backend/src/routes/admin.js`, mesmo
padrão de sempre)**:
- `GET /api/admin/affiliates?status=PENDING|APPROVED|REJECTED` — lista
  afiliações do seller "oaken" (via `course.sellerId`), com
  `user:{name,email}` e `course:{title,slug}`. Sem `status`, devolve
  todas.
- `PATCH /api/admin/affiliates/:id` — body `{ status: 'APPROVED' |
  'REJECTED' }` (Zod enum, `.strict()`). Define `decidedAt`. 404 se não
  existir.

**Atribuição de comissão em `POST /api/orders`
(`backend/src/routes/orders.js`, já existe)**: aceitar um campo opcional
`affiliateRef` no body (é o `id` do `Affiliate`). Se vier: procurar o
`Affiliate` com esse id, e só o aceitar se `status === 'APPROVED'` **e**
`courseId` bater com o curso a comprar — caso contrário, ignorar
silenciosamente (não rebentar a compra por causa de um `ref` inválido
ou adulterado, só não atribui comissão). Se válido, guardar
`affiliateId` na `Order` e calcular `commissionKz = Math.round(amountKz
* affiliate.commissionPct / 100)` — mas só grava o valor, não paga nada
(mesma regra do saldo em Financeiro: comissão é só informação até
existir dinheiro real).

**Critérios de aceitação:**
- Um utilizador nunca vê afiliações de outro em `/affiliates/me` (usa
  sempre `req.user.sub`).
- `affiliateRef` adulterado (id de outro curso, ou de uma afiliação
  ainda `PENDING`) nunca atribui comissão — a compra continua a
  funcionar normalmente, só sem `affiliateId`.
- `PATCH /api/admin/affiliates/:id` só aceita `APPROVED`/`REJECTED`
  (Zod enum) — qualquer outra coisa dá 400.
- `node --check` limpo em todos os ficheiros tocados.

## Tarefa 12 — Frontend de Afiliados (loja + painel) ✅ concluída, revista pelo sénior

Backend pronto (Tarefa 11): `POST /api/affiliates`, `GET
/api/affiliates/me`, `GET/PATCH /api/admin/affiliates`. `POST
/api/orders` já aceita `affiliateRef` opcional no body.

**Lado da loja (`frontend/curso.html`)**:
- Se o utilizador tem sessão e ainda não tem afiliação para este curso
  (`GET /api/affiliates/me`, procurar pelo `course.slug` da página
  actual), mostrar um botão "Tornar-me afiliado" na sidebar/buy-box.
  Ao clicar, `POST /api/affiliates {courseId}`, depois mostrar o estado
  actualizado (ver abaixo).
- Se já tem afiliação `PENDING` para este curso: mostrar "Pedido de
  afiliação em análise" (sem botão).
- Se já tem afiliação `APPROVED`: mostrar o link de indicação — a URL
  actual da página + `?ref=<affiliate.id>` — com um botão para copiar
  (`navigator.clipboard.writeText`).
- Se `REJECTED`: mostrar "Pedido de afiliação não aprovado" (sem botão
  de novo pedido — mantém simples, sem reenvio automático).
- Ao comprar (`buyCourse()` já existente): se a URL actual tiver
  `?ref=...`, incluir `affiliateRef: <esse valor>` no body de `POST
  /api/orders`. Não validar nada no cliente — o backend já decide se o
  ref é válido, o frontend só o passa adiante.

**Lado do painel (`frontend/admin/afiliados.html`, ficheiro novo)** —
mesmo layout das outras páginas do painel, sidebar sai de "Em breve"
(`admin.js`, item `afiliados`: `href: 'afiliados.html', soon: false`):
- 3 separadores: "Pendentes" / "Aprovados" / "Reprovados" (chamar `GET
  /api/admin/affiliates?status=...` conforme o separador activo).
  "Pendentes" activo por omissão.
- Cada linha: nome/email do candidato, curso, data do pedido,
  comissão (`commissionPct`%).
- Em "Pendentes": botões "Aprovar" / "Reprovar" por linha, chamam
  `PATCH /api/admin/affiliates/:id` com `{status:'APPROVED'}` ou
  `{status:'REJECTED'}`, depois recarregam a lista.
- Lista vazia: "Nenhuma solicitação pendente." (ou equivalente por
  separador) — nunca uma tabela fantasma "a carregar" eterna.

**Critérios de aceitação:**
- Link de indicação só aparece com afiliação `APPROVED` de verdade
  (vinda da API), nunca construído a partir de suposição no cliente.
- `affiliateRef` só é lido do URL da própria página, nunca inventado.
- Painel: aprovar/reprovar funciona e a lista actualiza sem reload da
  página inteira.
- Reaproveita `apiFetch`/`formatKz`/`initAdminPage`/tema — não duplica
  nada de `app.js`/`admin.js`.
- `node --check` limpo em todos os ficheiros tocados/criados.

## Tarefa 13 — Backend de Integrações: webhooks de saída + captura de UTM ✅ concluída, revista pelo sénior

Schema já migrado (`WebhookEndpoint`, `Order.utmSource/utmMedium/utmCampaign`
— ver `backend/prisma/schema.prisma`). Nada de simular integrações com
produtos de terceiros (UTMfy, Otimizey) — isso não existe aqui, seria
mentira. É webhook de saída de verdade + UTM de verdade.

**Webhooks — `GET/POST/DELETE /api/admin/webhooks`** (adicionar a
`admin.js`, mesmo padrão de sempre, seller fixo "oaken"):
- `GET /api/admin/webhooks` — lista os endpoints do seller. **Nunca**
  devolver o campo `secret` completo nesta rota — só os últimos 4
  caracteres (ex: `"secretPreview": "…a1b2"`), para o dono conseguir
  reconhecer qual é qual sem o segredo poder vazar por aqui.
- `POST /api/admin/webhooks` — body `{ url }` (Zod, `.url()`). Gera um
  `secret` aleatório forte no servidor (`crypto.randomBytes(32).toString('hex')`)
  — devolve o `secret` completo **só nesta resposta**, uma única vez (é
  a única oportunidade de o dono o copiar, como uma API key normal).
- `DELETE /api/admin/webhooks/:id` — remove. 404 se não existir.

**Disparo do webhook (`backend/src/routes/webhooks.js`, já existe)**:
depois de uma `Order` ficar `PAID` (dentro/depois da transacção que já
existe), buscar os `WebhookEndpoint` activos do seller "oaken" e para
cada um fazer `POST` ao `url` registado com:
```
body: { event: 'order.paid', orderId, courseId, amountKz, commissionKz, paidAt }
header: X-Oaken-Signature: <hex HMAC-SHA256 do JSON do body, usando o secret>
```
Usar `fetch` nativo do Node (já disponível), com um timeout curto (ex:
5s via `AbortController`) — **nunca deixar uma falha de rede num
webhook externo rebentar a confirmação do pagamento**: o disparo corre
depois da `Order` já estar confirmada como `PAID`, envolto em `try/catch`
que só regista o erro (`console.error`), nunca propaga.

**Captura de UTM em `POST /api/orders`
(`backend/src/routes/orders.js`, já existe)**: aceitar campos opcionais
`utmSource`, `utmMedium`, `utmCampaign` no body (Zod, strings simples,
sem regra especial) e gravá-los na `Order` tal como já se faz com
`affiliateRef`.

**Critérios de aceitação:**
- `secret` completo nunca aparece em `GET /api/admin/webhooks` — só a
  prévia de 4 caracteres.
- Falha ao chamar um webhook externo (URL fora do ar, timeout) nunca
  impede a compra/confirmação de pagamento — testar mentalmente com um
  URL que não responde.
- `X-Oaken-Signature` calculado correctamente com HMAC-SHA256 do body
  exacto que é enviado.
- `node --check` limpo em todos os ficheiros tocados.

## Tarefa 14 — Frontend de Integrações (painel: gerir webhooks) ✅ concluída, revista pelo sénior

Backend pronto (Tarefa 13): `GET/POST/DELETE /api/admin/webhooks`.

Página nova `frontend/admin/integracoes.html`, mesmo layout das outras
páginas do painel. Sidebar sai de "Em breve" (`admin.js`,
`ADMIN_NAV_ITEMS`, item `integracoes`: `href: 'integracoes.html', soon:
false`).

- Lista de webhooks registados (`GET /api/admin/webhooks`): URL,
  `secretPreview` (nunca o completo), data de criação, badge
  activo/inactivo, botão remover (`DELETE /api/admin/webhooks/:id`,
  confirmar com `confirm()` antes).
- Formulário/modal "Adicionar webhook": campo URL (`type="url"`,
  `required`). Ao submeter, `POST /api/admin/webhooks`. A resposta traz
  o `secret` completo **uma única vez** — mostrar num modal/caixa
  destacada com aviso claro ("Guarda este código agora — não vai voltar
  a ser mostrado") e botão copiar, antes de voltar à lista.
- Pequena nota explicativa no topo da página: "Sempre que uma venda for
  confirmada, a Oaken Market envia um pedido `POST` a cada URL abaixo,
  com o corpo assinado (cabeçalho `X-Oaken-Signature`, HMAC-SHA256 do
  corpo com o teu código secreto)." — para o dono saber o que está a
  configurar, mesmo sem documentação à parte.

**Regra de honestidade:** nada de UTMfy/Otimizey/qualquer marca de
terceiros — isto é só a gestão dos webhooks de saída próprios. Não
mostrar histórico de entregas (o backend não guarda log de entregas
nesta fase) nem inventar um.

**Critérios de aceitação:**
- `secret` completo só aparece na tela imediatamente a seguir à criação
  — nunca mais depois disso (a lista só mostra `secretPreview`).
- Remover pede confirmação antes de chamar a API.
- Reaproveita `apiFetch`/`formatKz`/`initAdminPage` — não duplica nada.
- `node --check` limpo.

## Tarefa 15 — Backend de Ranking (cursos e afiliados, dados reais) ✅ concluída, revista pelo sénior

Diferente de propósito do "Ranking de Produtores"/"Jornada Planetária"
do Kursinha (decisão do dono: não copiar essa parte, é gamificação com
níveis e recompensas fantasiosas). Aqui é simples: dois rankings de
desempenho real, sem inventar nada — nem níveis, nem badges, nem
percentagens de progresso para uma meta que ninguém definiu.

**`GET /api/admin/ranking/courses`** (adicionar a `admin.js`, mesmo
padrão): cursos do seller "oaken" ordenados por faturamento (soma de
`amountKz` de `Order` com `status: PAID`), decrescente. Cada item:
`{ courseId, title, slug, salesKz, salesCount }`. Cursos sem nenhuma
venda aparecem no fim com `salesKz: 0, salesCount: 0` (não esconder —
é informação real de "ainda não vendeu nada").

**`GET /api/admin/ranking/affiliates`**: afiliados com `status:
APPROVED` ordenados por comissão gerada (soma de `commissionKz` das
`Order` ligadas a cada `Affiliate` com `status: PAID`), decrescente.
Cada item: `{ affiliateId, userName, userEmail, courseTitle,
commissionKz, salesCount }`. Afiliados aprovados sem vendas ainda
aparecem com `commissionKz: 0` (mesma regra de honestidade).

**Critérios de aceitação:**
- Nenhum dos dois rankings inclui dados de outro seller (sempre
  filtrado por `course.sellerId` = seller "oaken").
- Cursos/afiliados sem vendas aparecem com zero, nunca escondidos nem
  com um valor inventado.
- `node --check` limpo.

## Tarefa 16 — Frontend de Ranking (dois rankings reais, sem gamificação) ✅ concluída, revista pelo sénior

Backend pronto (Tarefa 15): `GET /api/admin/ranking/courses`, `GET
/api/admin/ranking/affiliates`.

Página nova `frontend/admin/ranking.html`, mesmo layout do painel.
Sidebar sai de "Em breve" (`admin.js`, item `ranking`: `href:
'ranking.html', soon: false`).

- 2 separadores: "Cursos" (activo por omissão) e "Afiliados" — mesmo
  padrão de separadores de `afiliados.html`.
- "Cursos": tabela simples, posição (1º, 2º, 3º…), título do curso,
  faturamento (`formatKz(salesKz)`), nº de vendas. Sem medalhas
  fantasiosas nem badges de nível — é só uma tabela ordenada.
- "Afiliados": posição, nome/email, curso, comissão gerada
  (`formatKz(commissionKz)`), nº de vendas atribuídas.
- Lista vazia (ex: nenhum afiliado aprovado ainda): "Ainda não há
  afiliados aprovados." — nunca uma tabela fantasma.

**Regra de honestidade (repetida de propósito — é o ponto central desta
tarefa):** nada de níveis, planetas, medalhas de ouro/prata/bronze,
percentagens de progresso para uma meta, ou qualquer estética de jogo.
É uma tabela de desempenho, ponto final.

**Critérios de aceitação:**
- As duas tabelas mostram sempre dados reais da API, incluindo zeros
  (cursos/afiliados sem venda aparecem, não desaparecem).
- Nenhum elemento de gamificação (nível, badge, progresso, recompensa).
- Reaproveita `apiFetch`/`formatKz`/`initAdminPage` — não duplica nada.
- `node --check` limpo.

## Tarefa 17 — Backend "Explorar": vitrine pública de cursos para afiliação ✅ concluída, revista pelo sénior (+ campo category adicionado depois) (inclui `temperatureDegrees` = 30 + recentSalesCount×20, fórmula documentada no código)

Referência: página "Explorar" do Kursinha (vitrine de produtos para
quem quer ser afiliado, com indicador de "temperatura" de vendas e
comissão possível por venda). Fazemos a mesma ideia, mas a
"temperatura" é sempre um número real (vendas recentes), nunca um grau
inventado tipo "150°" sem fórmula por trás.

**`GET /api/affiliates/explore`** — rota pública (SEM `requireAuth`,
tem de ficar definida ANTES do `router.use(requireAuth(env))` em
`affiliates.js`, ou num router separado montado antes desse
middleware — qualquer visitante deve poder ver a vitrine antes de
criar conta). Lista todos os cursos publicados do seller "oaken",
ordenados por vendas recentes (mais vendido primeiro):

```
{ courses: [{
  id, slug, title, coverUrl, priceKz,
  commissionPct,        // 30, tem de bater com o default do schema (Affiliate.commissionPct)
  maxCommissionKz,       // round(priceKz * commissionPct / 100)
  recentSalesCount,      // contagem de Order PAID deste curso com createdAt >= agora-30 dias
}] }
```

`recentSalesCount` calculado com `prisma.order.groupBy` (mesmo padrão
já usado em `/stats`/`/ranking/courses` noutros ficheiros deste
projecto), filtrado por `createdAt: { gte: <há 30 dias> }` e
`status: 'PAID'`. Cursos sem vendas recentes aparecem com
`recentSalesCount: 0` (nunca escondidos).

**Critérios de aceitação:**
- Rota acessível sem token (visitante anónimo consegue ver a vitrine).
- `recentSalesCount` é sempre uma contagem real recalculada, nunca um
  número fixo ou fórmula inventada.
- Só cursos `published: true` do seller "oaken" aparecem.
- `node --check` limpo.

## Tarefa 18 — Frontend "Explorar" (vitrine de afiliação na loja) ✅ concluída, revista pelo sénior

Backend pronto (Tarefa 17): `GET /api/affiliates/explore` (pública),
devolve por curso: `id, slug, title, coverUrl, priceKz, commissionPct,
maxCommissionKz, recentSalesCount, temperatureDegrees`.

Página nova `frontend/explorar.html` — parte da LOJA pública (não do
painel admin), mesmo header/footer/tema de `index.html`/`curso.html`.
Link "Explorar" no header (`#header-actions` ou ao lado, visível a
todos, logados ou não).

- Grid de cards, um por curso: capa, título, preço, **"🌡️ X°"**
  (`temperatureDegrees`) e por baixo, em texto pequeno, o número real
  ("X vendas nos últimos 30 dias") — o grau nunca aparece sozinho sem
  o número real por perto. "Ganha até `maxCommissionKz` por venda"
  (`formatKz`).
- Botão "Tornar-me afiliado" em cada card: se não há sessão, redirecciona
  para `login.html?next=explorar.html`; se há sessão, `POST
  /api/affiliates {courseId}` (mesma chamada já usada em `curso.html`)
  e o botão muda para "Pedido enviado" (desactivado) — não precisa de
  saber o estado exacto aqui (isso já existe na página do curso), só
  dar feedback imediato do clique.

**Critérios de aceitação:**
- `temperatureDegrees` nunca aparece sem o número real de vendas ao
  lado, na mesma vista.
- Cursos com 0 vendas recentes aparecem na grelha na mesma (não
  escondidos por teren nota baixa).
- Reaproveita `apiFetch`/`formatKz`/`initTheme`/`renderHeader` de
  `app.js` — não duplica nada.
- `node --check` limpo.

## Tarefa 19 — Backend do Dashboard: série diária, por hora e por método ✅ concluída, revista pelo sénior

Referência: Dashboard do Kursinha tem "Faturamento diário" (gráfico por
dia no período), "Vendas por hora" (distribuição 00h-23h) e "Vendas por
método" (REF/EXPRESS/MANUAL — no nosso caso, o `provider` da `Order`).
Importante: estes gráficos têm de aparecer **mesmo com zero vendas** —
todos os dias/horas do período aparecem no array, com zero quando não
houver, nunca omitidos (é assim que o Kursinha mostra "0,1,2,3,4" no
eixo com a linha achatada em zero).

Adicionar a `admin.js`, mesmo padrão de sempre (seller fixo "oaken",
`requireAuth`+`requireAdmin` já aplicados no `router.use` do topo):

**`GET /api/admin/stats/daily?from=&to=`** — obrigatório `from`/`to`
(ISO). Devolve `{ days: [{ date: 'YYYY-MM-DD', salesKz, salesCount }] }`
com **uma entrada para cada dia do intervalo**, incluindo os dias sem
nenhuma `Order` PAID (zero). Implementação sugerida: buscar todas as
`Order` PAID do seller "oaken" no intervalo com `findMany` (dataset
pequeno nesta fase, não precisa de SQL agregado), agrupar por dia em
JS, e depois preencher os dias em falta com zero — nunca saltar um dia.

**`GET /api/admin/stats/hourly?from=&to=`** — mesmo intervalo
obrigatório. Devolve `{ hours: [{ hour: 0..23, salesKz, salesCount }] }`
— sempre as 24 entradas (0 a 23), agregando `Order` PAID do intervalo
pela hora local de `paidAt` (usar hora UTC é aceitável, documentar no
código qual se está a usar).

**`GET /api/admin/stats/by-provider?from=&to=`** — devolve `{
providers: [{ provider, salesKz, salesCount, pct }] }`, `pct` =
percentagem do `salesKz` desse provider sobre o total do período
(0 se o total for zero — nunca dividir por zero). Incluir todos os
providers que já tiveram alguma `Order` (mesmo fora do período? não —
só os que aparecem no período; se o período não tem nenhuma venda,
devolver `providers: []`, a página trata isso como "sem dados").

**Critérios de aceitação:**
- `stats/daily` e `stats/hourly` nunca omitem um dia/hora do intervalo
  pedido — testar mentalmente com um intervalo de 5 dias sem nenhuma
  venda: tem de devolver 5 entradas, todas a zero.
- `stats/by-provider` nunca divide por zero.
- `from`/`to` inválidos ou em falta devolvem 400 (reaproveitar
  `parseDateParam` já existente no ficheiro).
- `node --check` limpo.

## Tarefa 20 — Explorar: busca, filtro de categoria, ordenação e "Página do afiliado" ✅ concluída, revista pelo sénior

Referência: o dono mandou print real da vitrine do Kursinha (busca +
categorias + ordenar por + cards com "Página do afiliado"). Backend já
devolve `category` em cada curso (`GET /api/affiliates/explore`,
acabei de acrescentar). NÃO incluir "Order bump" — é uma funcionalidade
de cross-sell no checkout que não existe na plataforma, não vamos pôr
um link que não faz nada (isso seria enganar o utilizador).

Em `frontend/explorar.html`:
- Campo de busca (texto livre, filtra por `title` no cliente — não
  precisa de round-trip à API, os dados já vêm todos de uma vez).
- Dropdown "Categorias": "Todas as categorias" + lista das categorias
  realmente presentes nos cursos devolvidos (`[...new Set(courses.map(c
  => c.category).filter(Boolean))]`) — nunca uma lista fixa que pode
  não bater com os dados reais.
- Dropdown "Ordenar por": "Mais quentes" (`temperatureDegrees` desc,
  já é a ordem que a API devolve — é a opção por omissão), "Maior
  comissão" (`maxCommissionKz` desc), "Menor preço" (`priceKz` asc).
  Tudo reordenado no cliente, já têm os dados todos.
- Cada card ganha um link "🔗 Página do afiliado" que aponta para
  `curso.html?slug=<slug>` (pré-visualização da página de vendas do
  curso — antes de a afiliação ser aprovada ainda não há `ref` para
  colocar, é só a antevisão da página que vai promover).
- Busca/categoria/ordenação combinam-se (filtrar por busca E categoria,
  depois ordenar) — recalcular a grid a cada mudança, sem re-pedir a
  API.

**Critérios de aceitação:**
- Filtro de categoria só mostra categorias que existem mesmo nos dados
  devolvidos — nunca uma lista inventada/fixa.
- As 3 opções de ordenação funcionam e são recalculadas no cliente.
- Nenhum "Order bump" nem qualquer link que não leve a lado nenhum.
- `node --check` limpo.

## Tarefa 21 — Dashboard: gráficos de faturamento diário, vendas por hora e por método ✅ concluída, revista pelo sénior

Consome os endpoints da Tarefa 19 (`/api/admin/stats/daily`, `/hourly`,
`/by-provider`), reaproveitando o `currentPeriod`/`periodToRange()` já
existentes em `admin/index.html`. SVG inline à mão, sem biblioteca
externa (mesma restrição de sempre: sem framework, sem build step).

- **Gráfico de faturamento diário:** barras SVG, uma por dia do
  intervalo, altura proporcional a `salesKz`. Mesmo com zero vendas em
  todos os dias, as barras aparecem todas (achatadas em zero) — nunca
  omitir um dia.
- **Gráfico de vendas por hora:** 24 barras (0h-23h), mesma lógica.
- **Vendas por método de pagamento:** lista de barras horizontais, uma
  por `provider` devolvido. Se `providers: []` (sem vendas no período),
  mostra um estado "sem vendas neste período" em vez de um gráfico vazio
  a fingir que há dados.
- Todos os três em `.admin-panel` (mesmo estilo do card "Próximos
  passos" já existente), recarregam junto com o resto do dashboard
  quando o período muda.

**Critérios de aceitação (sénior valida):**
- Testado ao vivo com dados reais: período com a venda real (299 000 Kz,
  19/08) mostra o gráfico diário e o de hora certos; período sem vendas
  mostra as barras todas achatadas em zero, nunca escondidas.
- `node --check` limpo (não aplicável a `.html` inline, mas o JS embutido
  foi lido linha a linha).

**Nota da revisão (testado ao vivo, sessão local com backend real +
BD de produção, sessão de admin injectada via JWT assinado com o
`JWT_SECRET` real — sem alterar nem inventar dados):**
- Período "Tudo" (23/07–22/08): 31 barras diárias (30 a zero + 1 real de
  299 000 Kz no dia certo), 24 barras horárias (23 a zero + 1 real na
  hora certa, 16h UTC), "Vendas por método" mostra "Manual · 299 000 Kz ·
  100%" — nada omitido, nenhum dado inventado.
- Período "Hoje" (sem vendas reais nesse intervalo): 2 barras diárias,
  ambas a zero; 24 barras horárias, todas a zero; "Vendas por método"
  mostra correctamente "Sem vendas neste período." em vez de um gráfico
  vazio sem explicação.
- Resolvido o "período Tudo" não ter `from`/`to` (as rotas de série
  exigem sempre) usando a data de criação do curso mais antigo como
  `from` — nunca poderia haver venda antes de o curso existir.

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
- **Tarefa 19 (stats/daily, stats/hourly, stats/by-provider):** encontrado
  e corrigido um bug real testando ao vivo contra a BD de produção — quando
  `to` chega como data pura (ex: `"2026-08-19"`, sem hora), o `Date`
  interpreta isso como meia-noite UTC desse dia, e o filtro `lte: toDate`
  cortava fora qualquer venda feita mais tarde nesse mesmo dia. Resultado:
  uma venda real de 299 000 Kz aparecia como zero no dia correcto — um
  "zero falso", pior do que simplesmente esconder um zero real. Corrigido
  com `endOfUtcDay(toDate)`, que alarga sempre o limite superior até ao
  fim desse dia em UTC antes de consultar a BD, independentemente da hora
  que o chamador enviou. Reproduzido e confirmado corrigido com a venda
  real existente (offshore, 299 000 Kz, `manual`, `paidAt` 16:58 UTC) nas
  três rotas, mais intervalo de 5 dias sem vendas (5 dias a zero, nenhum
  omitido) e validação de datas inválidas/`from > to`/parâmetros em falta
  (400 em todos os casos).

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

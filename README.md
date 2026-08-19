# Oaken Market

Plataforma de venda de cursos online para Angola — pagamento local
(Multicaixa Express / Unitel Money), em português de Angola.

**Estado:** MVP em construção. Fase 1: só a Oaken vende os próprios cursos
(reaproveitando o conteúdo de `oaken-cursos`), com o schema já pensado
para abrir a outros criadores mais tarde sem reescrever a base de dados.

## Stack

- Backend: Node.js + Express + Prisma + PostgreSQL (Supabase, tier grátis)
- Auth: JWT + bcrypt
- Validação: Zod
- Segurança: Helmet, rate limiting
- Pagamento: abstração de provedor em `backend/src/services/payments/` —
  a integração real com Multicaixa Express / Unitel Money é tratada à
  parte e liga-se aí sem tocar no resto do backend.

## Estrutura

```
oaken-market/
├── backend/
│   ├── src/
│   │   ├── index.js
│   │   ├── config/        # env, prisma client
│   │   ├── middleware/    # auth, error handler
│   │   ├── routes/        # auth, courses, orders, webhooks
│   │   ├── services/payments/
│   │   └── prisma/schema.prisma
│   └── scripts/seed.js
├── frontend/               # por construir
└── docs/TASKS.md           # tarefas do MVP com critérios de aceitação
```

## Correr localmente

```bash
cd backend
cp .env.example .env   # preencher DATABASE_URL (Supabase) e JWT_SECRET
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run seed
npm run dev
```

`GET http://localhost:5000/health` deve devolver `{"status":"ok"}`.

## Estado das tarefas

Ver `docs/TASKS.md` — fluxo júnior implementa, sénior revisa antes de
avançar para a próxima tarefa.

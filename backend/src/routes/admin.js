const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../config/prisma');
const { HttpError } = require('../middleware/errorHandler');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const SELLER_SLUG = 'oaken';

const COURSE_TYPES = ['DIGITAL', 'PHYSICAL', 'SERVICE', 'PAYMENT'];

const createCourseSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'slug só pode ter minúsculas, números e hífens'),
  title: z.string().trim().min(1, 'title em falta'),
  description: z.string().trim().min(1, 'description em falta'),
  priceKz: z.number().int('priceKz tem de ser inteiro').positive('priceKz tem de ser positivo'),
  coverUrl: z.string().url('coverUrl inválido').optional(),
  category: z.string().trim().min(1).optional(),
  type: z.enum(COURSE_TYPES).optional(),
});

const updateCourseSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    priceKz: z.number().int('priceKz tem de ser inteiro').positive('priceKz tem de ser positivo').optional(),
    coverUrl: z.string().url('coverUrl inválido').optional(),
    category: z.string().trim().min(1).optional(),
    type: z.enum(COURSE_TYPES).optional(),
    published: z.boolean().optional(),
  })
  .strict();

const createModuleSchema = z.object({
  order: z.number().int('order tem de ser inteiro').nonnegative('order não pode ser negativo'),
  title: z.string().trim().min(1, 'title em falta'),
});

const createLessonSchema = z.object({
  order: z.number().int('order tem de ser inteiro').nonnegative('order não pode ser negativo'),
  title: z.string().trim().min(1, 'title em falta'),
  contentHtml: z.string().trim().min(1, 'contentHtml em falta'),
  durationMin: z.number().int('durationMin tem de ser inteiro').positive('durationMin tem de ser positivo').optional(),
});

const updateLessonSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    contentHtml: z.string().trim().min(1).optional(),
    durationMin: z.number().int('durationMin tem de ser inteiro').positive('durationMin tem de ser positivo').optional(),
  })
  .strict();

const ORDER_STATUSES = ['PENDING', 'PAID', 'FAILED', 'REFUNDED'];

const AFFILIATE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];

const listAffiliatesQuerySchema = z
  .object({
    status: z.enum(AFFILIATE_STATUSES).optional(),
  })
  .strict();

const updateAffiliateSchema = z
  .object({
    status: z.enum(['APPROVED', 'REJECTED']),
  })
  .strict();

const createWebhookSchema = z
  .object({
    url: z.string().trim().url('url inválido'),
  })
  .strict();

const listOrdersQuerySchema = z
  .object({
    status: z.enum(ORDER_STATUSES).optional(),
    from: z.string().trim().min(1).optional(),
    to: z.string().trim().min(1).optional(),
  })
  .strict();

const statsQuerySchema = z
  .object({
    from: z.string().trim().min(1).optional(),
    to: z.string().trim().min(1).optional(),
  })
  .strict();

// Ao contrário de statsQuerySchema (from/to opcionais), estas três rotas de
// série temporal exigem sempre from/to — sem intervalo não há como saber
// que dias/horas preencher com zero.
const seriesStatsQuerySchema = z
  .object({
    from: z.string().trim().min(1, 'from em falta'),
    to: z.string().trim().min(1, 'to em falta'),
  })
  .strict();

// Datas inválidas em `from`/`to` têm de dar 400, não rebentar 500 lá em
// baixo quando o Prisma recebe um Date inválido.
function parseDateParam(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, `${label} inválido`);
  }
  return date;
}

function buildCreatedAtFilter(from, to) {
  const filter = {};
  if (from) filter.gte = parseDateParam(from, 'from');
  if (to) filter.lte = parseDateParam(to, 'to');
  return filter;
}

// Prisma P2002 (unique constraint) devolve 409 com mensagem clara, em vez
// de rebentar como 500 — usado nos conflitos de `order` únicos por curso/módulo.
function isUniqueConstraintError(err) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

module.exports = function (env) {
  const router = express.Router();

  router.use(requireAuth(env), requireAdmin);

  router.post('/courses', async (req, res, next) => {
    try {
      const parsed = createCourseSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }
      const { slug, title, description, priceKz, coverUrl, category, type } = parsed.data;

      // sellerId nunca vem do body — vai sempre buscar o seller fixo "oaken".
      const seller = await prisma.seller.findUniqueOrThrow({ where: { slug: SELLER_SLUG } });

      const course = await prisma.course.create({
        data: {
          sellerId: seller.id,
          slug,
          title,
          description,
          priceKz,
          coverUrl,
          category,
          type,
          published: false,
        },
      });

      res.status(201).json({ course });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return next(new HttpError(409, 'Já existe um curso com este slug'));
      }
      next(err);
    }
  });

  router.patch('/courses/:id', async (req, res, next) => {
    try {
      const parsed = updateCourseSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }

      // slug e sellerId não entram aqui de propósito — não deixar mudar por
      // esta rota (partiria URLs já partilhadas / abriria brecha de vendedor).
      const course = await prisma.course.update({
        where: { id: req.params.id },
        data: parsed.data,
      });

      res.json({ course });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return next(new HttpError(404, 'Curso não encontrado'));
      }
      next(err);
    }
  });

  router.post('/courses/:id/modules', async (req, res, next) => {
    try {
      const parsed = createModuleSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }
      const { order, title } = parsed.data;

      const course = await prisma.course.findUnique({ where: { id: req.params.id } });
      if (!course) {
        return next(new HttpError(404, 'Curso não encontrado'));
      }

      const mod = await prisma.module.create({
        data: { courseId: course.id, order, title },
      });

      res.status(201).json({ module: mod });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return next(new HttpError(409, 'Já existe um módulo com este order neste curso'));
      }
      next(err);
    }
  });

  router.post('/modules/:id/lessons', async (req, res, next) => {
    try {
      const parsed = createLessonSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }
      const { order, title, contentHtml, durationMin } = parsed.data;

      const mod = await prisma.module.findUnique({ where: { id: req.params.id } });
      if (!mod) {
        return next(new HttpError(404, 'Módulo não encontrado'));
      }

      const lesson = await prisma.lesson.create({
        data: {
          moduleId: mod.id,
          order,
          title,
          contentHtml,
          ...(durationMin !== undefined ? { durationMin } : {}),
        },
      });

      res.status(201).json({ lesson });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return next(new HttpError(409, 'Já existe uma aula com este order neste módulo'));
      }
      next(err);
    }
  });

  router.patch('/lessons/:id', async (req, res, next) => {
    try {
      const parsed = updateLessonSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }

      const lesson = await prisma.lesson.update({
        where: { id: req.params.id },
        data: parsed.data,
      });

      res.json({ lesson });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return next(new HttpError(404, 'Aula não encontrada'));
      }
      next(err);
    }
  });

  // Lista TODOS os cursos do seller "oaken", incluindo rascunhos — ao
  // contrário de GET /api/courses (rota pública), que só mostra publicados.
  router.get('/courses', async (req, res, next) => {
    try {
      const seller = await prisma.seller.findUniqueOrThrow({ where: { slug: SELLER_SLUG } });

      const courses = await prisma.course.findMany({
        where: { sellerId: seller.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          slug: true,
          title: true,
          priceKz: true,
          published: true,
          coverUrl: true,
          category: true,
          type: true,
          createdAt: true,
          _count: { select: { orders: true, enrollments: true } },
        },
      });

      res.json({ courses });
    } catch (err) {
      next(err);
    }
  });

  router.get('/orders', async (req, res, next) => {
    try {
      const parsed = listOrdersQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Parâmetros inválidos'));
      }
      const { status, from, to } = parsed.data;
      const createdAtFilter = buildCreatedAtFilter(from, to);

      // sellerId nunca vem do cliente — fixo no seller "oaken", via
      // relação course.sellerId (Order não guarda sellerId directamente).
      const seller = await prisma.seller.findUniqueOrThrow({ where: { slug: SELLER_SLUG } });

      const orders = await prisma.order.findMany({
        where: {
          course: { sellerId: seller.id },
          ...(status ? { status } : {}),
          ...(Object.keys(createdAtFilter).length ? { createdAt: createdAtFilter } : {}),
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          createdAt: true,
          paidAt: true,
          status: true,
          amountKz: true,
          provider: true,
          course: { select: { title: true, slug: true } },
          user: { select: { name: true, email: true } },
        },
      });

      res.json({ orders });
    } catch (err) {
      next(err);
    }
  });

  router.get('/stats', async (req, res, next) => {
    try {
      const parsed = statsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Parâmetros inválidos'));
      }
      const { from, to } = parsed.data;
      const createdAtFilter = buildCreatedAtFilter(from, to);

      const seller = await prisma.seller.findUniqueOrThrow({ where: { slug: SELLER_SLUG } });

      const grouped = await prisma.order.groupBy({
        by: ['status'],
        where: {
          course: { sellerId: seller.id },
          ...(Object.keys(createdAtFilter).length ? { createdAt: createdAtFilter } : {}),
        },
        _sum: { amountKz: true },
        _count: { _all: true },
      });

      let approvedKz = 0;
      let approvedCount = 0;
      let pendingKz = 0;
      let pendingCount = 0;
      let cancelledKz = 0;
      let cancelledCount = 0;

      for (const group of grouped) {
        const kz = group._sum.amountKz || 0;
        const count = group._count._all;
        if (group.status === 'PAID') {
          approvedKz = kz;
          approvedCount = count;
        } else if (group.status === 'PENDING') {
          pendingKz = kz;
          pendingCount = count;
        } else {
          // FAILED e REFUNDED contam ambos como "canceladas".
          cancelledKz += kz;
          cancelledCount += count;
        }
      }

      // Nunca dividir por zero — sem encomendas PAID, o ticket médio é 0.
      const avgTicketKz = approvedCount > 0 ? Math.round(approvedKz / approvedCount) : 0;

      res.json({
        approvedKz,
        approvedCount,
        pendingKz,
        pendingCount,
        cancelledKz,
        cancelledCount,
        avgTicketKz,
      });
    } catch (err) {
      next(err);
    }
  });

  // Série diária de faturamento (Order PAID, por dia de `paidAt`, em UTC).
  // from/to são obrigatórios: sem intervalo não há dias para preencher.
  // O array `days` tem SEMPRE uma entrada por cada dia do intervalo,
  // incluindo dias sem nenhuma venda (zero) — nunca omitido, para o
  // gráfico do dashboard não "saltar" dias.
  router.get('/stats/daily', async (req, res, next) => {
    try {
      const parsed = seriesStatsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Parâmetros inválidos'));
      }
      const { from, to } = parsed.data;
      const fromDate = parseDateParam(from, 'from');
      const toDate = parseDateParam(to, 'to');
      if (fromDate > toDate) {
        return next(new HttpError(400, 'from tem de ser anterior ou igual a to'));
      }

      const seller = await prisma.seller.findUniqueOrThrow({ where: { slug: SELLER_SLUG } });

      // Dataset pequeno nesta fase (fase inicial do MVP) — não precisa de
      // SQL agregado, buscamos tudo e agrupamos em JS.
      const orders = await prisma.order.findMany({
        where: {
          course: { sellerId: seller.id },
          status: 'PAID',
          paidAt: { gte: fromDate, lte: toDate },
        },
        select: { paidAt: true, amountKz: true },
      });

      // Pré-preenche TODOS os dias do intervalo com zero (chave YYYY-MM-DD,
      // dia calendário em UTC) — só depois soma o que vier da BD por cima.
      const daysByKey = new Map();
      const cursor = new Date(
        Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate())
      );
      const endCursor = new Date(
        Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate())
      );
      while (cursor <= endCursor) {
        const key = cursor.toISOString().slice(0, 10);
        daysByKey.set(key, { date: key, salesKz: 0, salesCount: 0 });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }

      for (const order of orders) {
        if (!order.paidAt) continue;
        const key = order.paidAt.toISOString().slice(0, 10);
        const entry = daysByKey.get(key);
        if (!entry) continue; // fora do intervalo (não deveria acontecer, filtro já aplicado)
        entry.salesKz += order.amountKz;
        entry.salesCount += 1;
      }

      res.json({ days: Array.from(daysByKey.values()) });
    } catch (err) {
      next(err);
    }
  });

  // Distribuição de vendas por hora do dia (0-23), somando Order PAID do
  // intervalo pela hora UTC de `paidAt` (documentado: usamos hora UTC, não
  // hora local de Angola). Sempre as 24 entradas, mesmo sem vendas nalgumas.
  router.get('/stats/hourly', async (req, res, next) => {
    try {
      const parsed = seriesStatsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Parâmetros inválidos'));
      }
      const { from, to } = parsed.data;
      const fromDate = parseDateParam(from, 'from');
      const toDate = parseDateParam(to, 'to');
      if (fromDate > toDate) {
        return next(new HttpError(400, 'from tem de ser anterior ou igual a to'));
      }

      const seller = await prisma.seller.findUniqueOrThrow({ where: { slug: SELLER_SLUG } });

      const orders = await prisma.order.findMany({
        where: {
          course: { sellerId: seller.id },
          status: 'PAID',
          paidAt: { gte: fromDate, lte: toDate },
        },
        select: { paidAt: true, amountKz: true },
      });

      // Pré-preenche as 24 horas com zero antes de somar — nunca omitir uma.
      const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, salesKz: 0, salesCount: 0 }));

      for (const order of orders) {
        if (!order.paidAt) continue;
        const hour = order.paidAt.getUTCHours();
        hours[hour].salesKz += order.amountKz;
        hours[hour].salesCount += 1;
      }

      res.json({ hours });
    } catch (err) {
      next(err);
    }
  });

  // Vendas por método de pagamento (`provider` da Order PAID) no intervalo.
  // Só inclui providers que tiveram alguma venda DENTRO do período pedido —
  // se o período não teve nenhuma venda, devolve providers: [] (a página
  // trata isso como "sem dados"). `pct` nunca divide por zero.
  router.get('/stats/by-provider', async (req, res, next) => {
    try {
      const parsed = seriesStatsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Parâmetros inválidos'));
      }
      const { from, to } = parsed.data;
      const fromDate = parseDateParam(from, 'from');
      const toDate = parseDateParam(to, 'to');
      if (fromDate > toDate) {
        return next(new HttpError(400, 'from tem de ser anterior ou igual a to'));
      }

      const seller = await prisma.seller.findUniqueOrThrow({ where: { slug: SELLER_SLUG } });

      const grouped = await prisma.order.groupBy({
        by: ['provider'],
        where: {
          course: { sellerId: seller.id },
          status: 'PAID',
          paidAt: { gte: fromDate, lte: toDate },
        },
        _sum: { amountKz: true },
        _count: { _all: true },
      });

      const totalKz = grouped.reduce((sum, g) => sum + (g._sum.amountKz || 0), 0);

      // Sem nenhuma venda PAID no período: providers vazio, nunca dividir
      // por zero para calcular pct.
      const providers = grouped.map((g) => {
        const salesKz = g._sum.amountKz || 0;
        return {
          provider: g.provider,
          salesKz,
          salesCount: g._count._all,
          pct: totalKz > 0 ? Math.round((salesKz / totalKz) * 10000) / 100 : 0,
        };
      });

      res.json({ providers });
    } catch (err) {
      next(err);
    }
  });

  // Saldo (carteira): soma só dinheiro REAL — nunca o provedor "manual"
  // (esse é só para testar o fluxo de compra, nunca moveu dinheiro nenhum,
  // ver services/payments/manualProvider.js). Sem from/to: é o saldo
  // actual, não um relatório por período.
  router.get('/wallet', async (req, res, next) => {
    try {
      const seller = await prisma.seller.findUniqueOrThrow({ where: { slug: SELLER_SLUG } });

      const grouped = await prisma.order.groupBy({
        by: ['status'],
        where: {
          course: { sellerId: seller.id },
          status: { in: ['PAID', 'PENDING'] },
          // Exclusão central desta rota: provider "manual" nunca entra no
          // saldo, porque nunca moveu dinheiro real (é só teste de fluxo).
          provider: { not: 'manual' },
        },
        _sum: { amountKz: true },
      });

      let availableKz = 0;
      let pendingKz = 0;

      for (const group of grouped) {
        const kz = group._sum.amountKz || 0;
        if (group.status === 'PAID') {
          availableKz = kz;
        } else if (group.status === 'PENDING') {
          pendingKz = kz;
        }
      }

      res.json({
        availableKz,
        pendingKz,
        totalKz: availableKz + pendingKz,
      });
    } catch (err) {
      next(err);
    }
  });

  // Lista afiliações do seller "oaken" (via course.sellerId). Sem `status`,
  // devolve todas.
  router.get('/affiliates', async (req, res, next) => {
    try {
      const parsed = listAffiliatesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Parâmetros inválidos'));
      }
      const { status } = parsed.data;

      const seller = await prisma.seller.findUniqueOrThrow({ where: { slug: SELLER_SLUG } });

      const affiliates = await prisma.affiliate.findMany({
        where: {
          course: { sellerId: seller.id },
          ...(status ? { status } : {}),
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          commissionPct: true,
          createdAt: true,
          decidedAt: true,
          user: { select: { name: true, email: true } },
          course: { select: { title: true, slug: true } },
        },
      });

      res.json({ affiliates });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/affiliates/:id', async (req, res, next) => {
    try {
      const parsed = updateAffiliateSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }
      const { status } = parsed.data;

      const affiliate = await prisma.affiliate.update({
        where: { id: req.params.id },
        data: { status, decidedAt: new Date() },
      });

      res.json({ affiliate });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return next(new HttpError(404, 'Afiliação não encontrada'));
      }
      next(err);
    }
  });

  // Lista os endpoints de webhook do seller "oaken". O `secret` completo
  // NUNCA sai daqui — só a prévia dos últimos 4 caracteres, para o dono
  // conseguir reconhecer qual é qual sem o segredo poder vazar por esta
  // rota (ex: numa captura de ecrã ou log de rede).
  router.get('/webhooks', async (req, res, next) => {
    try {
      const seller = await prisma.seller.findUniqueOrThrow({ where: { slug: SELLER_SLUG } });

      const webhooks = await prisma.webhookEndpoint.findMany({
        where: { sellerId: seller.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          url: true,
          active: true,
          createdAt: true,
          secret: true,
        },
      });

      res.json({
        webhooks: webhooks.map(({ secret, ...rest }) => ({
          ...rest,
          secretPreview: `…${secret.slice(-4)}`,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // Regista um novo endpoint de webhook. O `secret` gerado aqui é devolvido
  // completo só nesta resposta, uma única vez — como uma API key normal, é
  // a única oportunidade de o dono o copiar (GET /webhooks nunca o mostra).
  router.post('/webhooks', async (req, res, next) => {
    try {
      const parsed = createWebhookSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new HttpError(400, parsed.error.issues[0]?.message || 'Dados inválidos'));
      }
      const { url } = parsed.data;

      const seller = await prisma.seller.findUniqueOrThrow({ where: { slug: SELLER_SLUG } });

      const secret = crypto.randomBytes(32).toString('hex');

      const webhook = await prisma.webhookEndpoint.create({
        data: { sellerId: seller.id, url, secret },
      });

      res.status(201).json({
        webhook: {
          id: webhook.id,
          url: webhook.url,
          active: webhook.active,
          createdAt: webhook.createdAt,
          secret: webhook.secret,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // Ranking de cursos por faturamento (soma de amountKz de Order PAID),
  // decrescente. Cursos sem nenhuma venda aparecem no fim com zero — nunca
  // escondidos, é informação real de "ainda não vendeu nada".
  router.get('/ranking/courses', async (req, res, next) => {
    try {
      const seller = await prisma.seller.findUniqueOrThrow({ where: { slug: SELLER_SLUG } });

      const courses = await prisma.course.findMany({
        where: { sellerId: seller.id },
        select: { id: true, title: true, slug: true },
      });

      const grouped = await prisma.order.groupBy({
        by: ['courseId'],
        where: {
          course: { sellerId: seller.id },
          status: 'PAID',
        },
        _sum: { amountKz: true },
        _count: { _all: true },
      });

      const salesByCourseId = new Map(
        grouped.map((g) => [g.courseId, { salesKz: g._sum.amountKz || 0, salesCount: g._count._all }])
      );

      const ranking = courses
        .map((course) => {
          const sales = salesByCourseId.get(course.id) || { salesKz: 0, salesCount: 0 };
          return {
            courseId: course.id,
            title: course.title,
            slug: course.slug,
            salesKz: sales.salesKz,
            salesCount: sales.salesCount,
          };
        })
        .sort((a, b) => b.salesKz - a.salesKz);

      res.json({ ranking });
    } catch (err) {
      next(err);
    }
  });

  // Ranking de afiliados aprovados por comissão gerada (soma de
  // commissionKz de Order PAID ligadas a cada Affiliate), decrescente.
  // Afiliados aprovados sem vendas ainda aparecem com zero.
  router.get('/ranking/affiliates', async (req, res, next) => {
    try {
      const seller = await prisma.seller.findUniqueOrThrow({ where: { slug: SELLER_SLUG } });

      const affiliates = await prisma.affiliate.findMany({
        where: {
          course: { sellerId: seller.id },
          status: 'APPROVED',
        },
        select: {
          id: true,
          user: { select: { name: true, email: true } },
          course: { select: { title: true } },
        },
      });

      const affiliateIds = affiliates.map((a) => a.id);

      const grouped = affiliateIds.length
        ? await prisma.order.groupBy({
            by: ['affiliateId'],
            where: {
              affiliateId: { in: affiliateIds },
              status: 'PAID',
            },
            _sum: { commissionKz: true },
            _count: { _all: true },
          })
        : [];

      const commissionByAffiliateId = new Map(
        grouped.map((g) => [g.affiliateId, { commissionKz: g._sum.commissionKz || 0, salesCount: g._count._all }])
      );

      const ranking = affiliates
        .map((affiliate) => {
          const commission = commissionByAffiliateId.get(affiliate.id) || { commissionKz: 0, salesCount: 0 };
          return {
            affiliateId: affiliate.id,
            userName: affiliate.user.name,
            userEmail: affiliate.user.email,
            courseTitle: affiliate.course.title,
            commissionKz: commission.commissionKz,
            salesCount: commission.salesCount,
          };
        })
        .sort((a, b) => b.commissionKz - a.commissionKz);

      res.json({ ranking });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/webhooks/:id', async (req, res, next) => {
    try {
      await prisma.webhookEndpoint.delete({ where: { id: req.params.id } });
      res.status(204).end();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return next(new HttpError(404, 'Webhook não encontrado'));
      }
      next(err);
    }
  });

  return router;
};

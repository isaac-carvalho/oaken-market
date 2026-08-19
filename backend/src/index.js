const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { loadEnv } = require('./config/env');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const env = loadEnv();

const app = express();
app.use(helmet());
app.use(cors({ origin: env.allowedOrigin }));
app.use(express.json());

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use(generalLimiter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'oaken-market' });
});

app.use('/api/auth', authLimiter, require('./routes/auth')(env));
app.use('/api/courses', require('./routes/courses')(env));
app.use('/api/orders', require('./routes/orders')(env));
app.use('/api/webhooks', require('./routes/webhooks')(env));

app.use(notFound);
app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`oaken-market backend a correr na porta ${env.port} (${env.nodeEnv})`);
});

const REQUIRED = ['DATABASE_URL', 'JWT_SECRET', 'ALLOWED_ORIGIN'];

function loadEnv() {
  require('dotenv').config();

  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Variáveis de ambiente em falta: ${missing.join(', ')}`);
  }
  if (process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET precisa de pelo menos 32 caracteres (openssl rand -base64 32)');
  }

  return {
    port: parseInt(process.env.PORT || '5000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    databaseUrl: process.env.DATABASE_URL,
    jwtSecret: process.env.JWT_SECRET,
    // ALLOWED_ORIGIN aceita uma lista separada por vírgulas (ex: para
    // servir mais do que uma loja/frontend a partir deste mesmo backend).
    allowedOrigins: process.env.ALLOWED_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
  };
}

module.exports = { loadEnv };

// Stub temporário — junior substitui pela implementação real.
module.exports = function stubRouter(name) {
  const express = require('express');
  const router = express.Router();
  router.use((req, res) => {
    res.status(501).json({ error: `Rota ${name} ainda não implementada` });
  });
  return router;
};

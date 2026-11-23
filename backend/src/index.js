const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { initDb } = require('./db');
const { requireAuth } = require('./middleware/auth');
const syncRoutes = require('./routes/sync');
const filesRoutes = require('./routes/files');
const { router: sharesRoutes, publicRouter } = require('./routes/shares');
const { gcPartials } = require('./services/fileStore');

function createApp() {
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  // A heavily annotated page of ink is a big JSON document, and a push can
  // carry many pages.
  app.use(express.json({ limit: '60mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'quarc-reader-backend' }));

  // Share-link readers need no account: the link is the credential.
  app.use('/api/public', publicRouter);

  app.use('/api/sync', requireAuth, syncRoutes);
  app.use('/api/files', requireAuth, filesRoutes);
  app.use('/api/shares', requireAuth, sharesRoutes);
  return app;
}

module.exports = { createApp };

if (require.main === module) {
  const PORT = process.env.PORT || 3008;
  initDb();
  gcPartials();
  setInterval(gcPartials, 6 * 3600 * 1000).unref();
  createApp().listen(PORT, () => {
    console.log(`Quarc Reader backend listening on :${PORT}`);
  });
}

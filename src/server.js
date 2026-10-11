import express from 'express';
import { toNodeHandler, localhostHostValidation } from '@modelcontextprotocol/node';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { ZodError } from 'zod';
import { Store } from './store.js';
import { createHandler } from './mcp.js';
import { dataDir, readInstance, writeInstance } from './runtime.js';

const root = fileURLToPath(new URL('../', import.meta.url));
export function createApp({ dbPath = resolve(dataDir, 'indri.sqlite'), baseUrl = 'http://127.0.0.1:4317' } = {}) {
  const store = new Store(dbPath);
  const mcp = createHandler(store, baseUrl);
  const app = express();
  app.disable('x-powered-by');
  const validateHost = localhostHostValidation();
  app.use((req, res, next) => {
    if (!validateHost(req, res)) return;
    if (req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch { return res.status(403).json({ error: 'Invalid origin.' }); }
      if (origin.origin !== `http://${req.headers.host}`) return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
    }
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    next();
  });
  // The MCP adapter reads its own request body; mount before express.json().
  app.all('/mcp', toNodeHandler(mcp, { maxRequestBodySize: 1024 * 1024 }));
  app.use(express.json({ limit: '1mb', type: 'application/json' }));
  app.get('/health', (req, res) => res.json({ ok: true, service: 'indri', pid: process.pid }));
  app.get('/api/diagrams', (req, res) => res.json(store.list()));
  app.get('/api/diagrams/:id', (req, res) => res.json(store.get(req.params.id, req.query.revision === undefined ? undefined : Number(req.query.revision))));
  app.get('/api/diagrams/:id/versions', (req, res) => res.json(store.versions(req.params.id)));
  app.post('/api/diagrams/:id/restore', (req, res) => res.json(store.restore(req.params.id, req.body)));
  app.post('/api/diagrams/:id/comments', (req, res) => res.json(store.comment(req.params.id, req.body)));
  app.post('/api/diagrams/:id/comments/:comment/replies', (req, res) => res.json(store.reply(req.params.id, req.params.comment, req.body)));
  app.patch('/api/diagrams/:id/comments/:comment', (req, res) => res.json(store.setStatus(req.params.id, req.params.comment, req.body)));
  app.use(express.static(resolve(root, 'public')));
  app.use((error, req, res, next) => {
    const status = error instanceof ZodError ? 400 : error.status || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status >= 500 ? 'An internal error occurred.' : error.message });
  });
  return { app, store, mcp };
}

const entryPath = process.env.pm_exec_path || process.argv[1];
if (entryPath && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  const managed = process.env.INDRI_MANAGED === '1';
  const preferred = managed ? readInstance()?.port : undefined;
  const requestedPort = preferred || Number(process.env.PORT || 4317);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('PORT must be 0–65535.');
  const http = createServer();
  await new Promise((resolve, reject) => {
    const onError = error => {
      if (managed && error.code === 'EADDRINUSE') http.listen(0, '127.0.0.1');
      else reject(error);
    };
    http.on('error', onError);
    http.once('listening', () => { http.off('error', onError); resolve(); });
    http.listen(requestedPort, '127.0.0.1');
  });
  const port = http.address().port;
  const { app, store, mcp } = createApp({ dbPath: process.env.INDRI_DB_PATH, baseUrl: `http://127.0.0.1:${port}` });
  http.on('request', app);
  if (managed) writeInstance({ port, pid: process.pid });
  console.log(`Indri review: http://127.0.0.1:${port} · MCP: /mcp`);
  process.send?.('ready');
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await mcp.close();
    http.close(() => { store.close(); process.exit(0); });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

import http from 'node:http';
import { config } from './lib/config.js';
import { boreal } from './lib/boreal.js';
import { createTracker } from './lib/tracker.js';
import { createPassthrough, PASSTHROUGH_ENDPOINTS } from './lib/passthrough.js';
import { serveStatic } from './lib/static.js';

const MAX_BODY_BYTES = 64 * 1024;

const tracker = createTracker({ api: boreal });
const passthrough = createPassthrough();

function corsHeaders(origin) {
  const allowed = config.allowedOrigins;
  if (!origin || !(allowed.includes('*') || allowed.includes(origin))) return {};
  return { 'Access-Control-Allow-Origin': allowed.includes('*') ? '*' : origin, Vary: 'Origin' };
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
    ...headers,
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
}

async function handleApi(req, res, endpoint, url, cors) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...cors,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'anyride-profile-data, anyride-profile-display, content-type',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  if (endpoint === '/health') {
    sendJson(res, 200, { ok: true, uptimeSeconds: Math.round(process.uptime()), ...tracker.status() }, cors);
    return;
  }

  if (endpoint === '/buses' || endpoint === '/stops') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' }, cors);
      return;
    }
    try {
      const payload = endpoint === '/buses' ? await tracker.getBuses() : await tracker.getStops();
      sendJson(res, 200, payload, cors);
    } catch (err) {
      sendJson(res, 502, { error: err.message }, cors);
    }
    return;
  }

  if (PASSTHROUGH_ENDPOINTS.has(endpoint)) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' }, cors);
      return;
    }
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    try {
      const upstream = await passthrough(endpoint, { method: req.method, search: url.search, body });
      res.writeHead(upstream.status, {
        'Content-Type': upstream.contentType ?? 'application/json',
        'Content-Length': upstream.body.length,
        'Cache-Control': 'no-cache',
        'X-Cache': upstream.cache,
        ...cors,
      });
      res.end(upstream.body);
    } catch (err) {
      sendJson(res, 502, { error: err.message }, cors);
    }
    return;
  }

  sendJson(res, 404, { error: 'Unknown endpoint' }, cors);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname.slice('/api'.length), url, corsHeaders(req.headers.origin));
      return;
    }

    if (config.staticDir && (await serveStatic(req, res, config.staticDir, pathname))) return;
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    if (err.status !== 413) console.error(err);
    if (res.headersSent) res.end();
    else sendJson(res, err.status ?? 500, { error: err.status === 413 ? err.message : 'Internal error' });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Boreal bus server listening on http://${config.host}:${config.port}`);
  console.log(config.staticDir ? `Serving frontend from ${config.staticDir}` : 'Static hosting disabled (API only)');
  // Warm the cache so the first visitor doesn't wait for the initial scan.
  tracker.getBuses().catch((err) => console.warn(`Initial refresh failed: ${err.message}`));
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

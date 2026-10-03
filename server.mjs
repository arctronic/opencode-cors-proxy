#!/usr/bin/env node
/* CORS proxy for the opencode Zen API.
 *
 * opencode sends no Access-Control-Allow-Origin on its responses and returns 404 to the
 * preflight for /chat/completions, so a browser page cannot call it directly. This sits in
 * front and adds what is missing.
 *
 * It never stores an API key. The caller's Authorization header is forwarded upstream
 * as-is and nothing is written to disk.
 */

import { createServer } from 'node:http';
import { Readable } from 'node:stream';

const PORT = Number(process.env.PORT || process.env.PROXY_PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const UPSTREAM = (process.env.UPSTREAM || 'https://opencode.ai/zen/go/v1').replace(/\/+$/, '');
const USER_AGENT = process.env.USER_AGENT || 'opencode-cors-proxy/1.0';

/* Comma-separated origins allowed to use this proxy, or "*" for any.
   "*" on a public host means any website can spend a caller's quota through you. */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',').map((s) => s.trim()).filter(Boolean);

/* Optional shared secret. When set, callers must send it as x-proxy-token.
   This is what stops a public deployment being an open relay. */
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';

const RATE_LIMIT = Number(process.env.RATE_LIMIT || 60);      // requests per window, per IP
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60_000);
/* 1 MB was enough for a browser chat but far too small for a coding agent: a
   1M-token context is roughly 4 MB of text before JSON overhead, and tool output
   and file contents push it higher. 32 MB is still a bound, not an invitation. */
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 32_000_000);

const ALLOWED_PATHS = /^\/(chat\/completions|models|responses|messages)(\?.*)?$/;

/* Some clients probe the base URL to discover an endpoint. Upstream serves its marketing
   site there, which is useless to them, so treat a bare root as a request for the model
   list - the OpenAI-compatible way to enumerate an endpoint. */
function normalisePath(path) {
  return path === '/' || path === '' ? '/models' : path;
}

/* ------------------------------------------------------------------ helpers */

function originAllowed(origin) {
  if (ALLOWED_ORIGINS.includes('*')) return true;
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin);
}

/* A file:// page sends Origin: null, which is a legitimate value to echo back.
   "*" cannot be used when credentials are involved, so echo the caller instead. */
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Authorization, X-Api-Key, Anthropic-Version, Content-Type, X-Opencode-Session, X-Proxy-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function clientIp(req) {
  /* Behind Cloudflare every request arrives from a Cloudflare edge IP, so the socket
     address is useless for rate limiting. CF-Connecting-IP is set by Cloudflare itself and
     cannot be spoofed by the client once traffic is locked to Cloudflare; X-Forwarded-For
     is the fallback for EasyPanel's own reverse proxy. */
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.length) return cf.trim();
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

const hits = new Map();
function rateLimited(ip) {
  if (RATE_LIMIT <= 0) return false;
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

// Drop expired buckets so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) if (now > entry.resetAt) hits.delete(ip);
}, RATE_WINDOW_MS).unref();

function tooLarge() {
  return Object.assign(new Error('Request body too large'), { statusCode: 413 });
}

function readBody(req, limit) {
  // Reject on the declared size before reading a byte, when the client declares one.
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared > limit) return Promise.reject(tooLarge());

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        // Stop reading, but leave the socket open so a 413 can still be written.
        req.pause();
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks)); });
    req.on('error', (err) => { if (!done) reject(err); });
  });
}

function sendJson(res, status, headers, payload, req) {
  res.writeHead(status, { ...headers, 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
  // Rejections used to be silent, which made client-side failures invisible here.
  if (req) console.log(req.method, req.url, '->', status, '(rejected)');
}

/* Fallback so a caller that omits a conversation id is not rejected upstream. */
const FALLBACK_SESSION = 'proxy-' + Math.random().toString(36).slice(2, 10);

/* -------------------------------------------------------------------- server */

export function createProxyServer() {
  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = corsHeaders(origin);

    // Unauthenticated liveness check for the platform's health probe.
    if (req.url === '/healthz') {
      sendJson(res, 200, cors, { ok: true, upstream: UPSTREAM });
      return;
    }

    if (!originAllowed(origin)) {
      sendJson(res, 403, {}, { error: { message: 'Origin not allowed: ' + (origin || '(none)') } }, req);
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (PROXY_TOKEN && req.headers['x-proxy-token'] !== PROXY_TOKEN) {
      sendJson(res, 401, cors, { error: { message: 'Missing or invalid x-proxy-token.' } }, req);
      return;
    }

    const path = normalisePath(req.url || '/');
    if (!ALLOWED_PATHS.test(path)) {
      sendJson(res, 404, cors, { error: { message: 'Not a proxied path: ' + path } }, req);
      return;
    }

    if (rateLimited(clientIp(req))) {
      sendJson(res, 429, cors, { error: { message: 'Rate limit exceeded. Try again shortly.' } }, req);
      return;
    }

    /* Two call shapes reach the same upstream:
         - OpenAI style (/chat/completions, /models) authenticates with Authorization: Bearer
         - Anthropic style (/messages), which Claude Code speaks, uses x-api-key
       Accept whichever the caller sent and pass it through untouched. */
    const bearer = req.headers.authorization;
    const apiKey = req.headers['x-api-key'];
    if (!bearer && !apiKey) {
      sendJson(res, 401, cors, {
        error: { message: 'Missing credentials. Send Authorization: Bearer <key> or x-api-key: <key>.' }
      }, req);
      return;
    }

    const headers = {
      'user-agent': USER_AGENT,
      // opencode routes and caches per conversation and 400s without this. Claude Code
      // does not send it, so supplying it here is what makes that client work at all.
      'x-opencode-session': req.headers['x-opencode-session'] || FALLBACK_SESSION
    };
    if (bearer) headers.authorization = bearer;
    if (apiKey) headers['x-api-key'] = apiKey;
    if (req.headers['anthropic-version']) headers['anthropic-version'] = req.headers['anthropic-version'];
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    if (req.headers.accept) headers.accept = req.headers.accept;

    try {
      const body = req.method === 'GET' || req.method === 'HEAD'
        ? undefined
        : await readBody(req, MAX_BODY_BYTES);

      const upstream = await fetch(UPSTREAM + path, { method: req.method, headers, body });

      const out = { ...cors };
      const upstreamType = upstream.headers.get('content-type');
      if (upstreamType) out['content-type'] = upstreamType;

      /* Token streaming arrives as text/event-stream. Cloudflare and most reverse proxies
         will buffer that into one lump unless told not to, which turns a streaming reply
         into a long silence then a wall of text. */
      if (upstreamType && upstreamType.includes('text/event-stream')) {
        out['cache-control'] = 'no-cache, no-transform';
        out['x-accel-buffering'] = 'no';
        out.connection = 'keep-alive';
      } else {
        const cacheControl = upstream.headers.get('cache-control');
        if (cacheControl) out['cache-control'] = cacheControl;
      }
      res.writeHead(upstream.status, out);
      if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
      else res.end();

      // Never log the Authorization header.
      console.log(req.method, path, '->', upstream.status);
    } catch (err) {
      const status = err.statusCode || 502;
      sendJson(res, status, cors, { error: { message: 'Proxy error: ' + err.message } });
      // Only now cut off a client still uploading an oversized body.
      if (status === 413) req.destroy();
      console.error(req.method, path, '->', status, err.message);
    }
  });
}

/* Started directly rather than imported by a test. */
if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  const server = createProxyServer();
  server.listen(PORT, HOST, () => {
    // PORT may be 0, meaning "any free port", so report what was actually bound.
    const bound = server.address();
    console.log('opencode-cors-proxy listening on ' + HOST + ':' + bound.port);
    console.log('  upstream        ' + UPSTREAM);
    console.log('  allowed origins ' + ALLOWED_ORIGINS.join(', '));
    console.log('  rate limit      ' + RATE_LIMIT + ' req / ' + RATE_WINDOW_MS + 'ms per IP');
    console.log('  token gate      ' + (PROXY_TOKEN ? 'on' : 'OFF'));
    if (ALLOWED_ORIGINS.includes('*') && !PROXY_TOKEN) {
      console.warn('');
      console.warn('  WARNING: any origin is allowed and no PROXY_TOKEN is set.');
      console.warn('  On a public host this is an open relay. Set ALLOWED_ORIGINS, PROXY_TOKEN, or both.');
      console.warn('');
    }
  });

  // PID 1 in a container gets no default signal handling, so docker stop would hang.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(signal + ' received, shutting down');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

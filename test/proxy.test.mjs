/* Tests the proxy against a mock upstream. No API key, no network.
 *
 * Each test spawns the real server.mjs as a child process with its own env, so what is
 * exercised is the shipped entry point rather than an imported stub. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createMockUpstream } from './mock-upstream.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '..', 'server.mjs');

let mock;
let upstreamPort;
const running = [];

async function startProxy(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      UPSTREAM: 'http://127.0.0.1:' + upstreamPort,
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  running.push(child);

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy did not start in time')), 10_000);
    child.stdout.on('data', (buf) => {
      const line = buf.toString();
      const match = line.match(/listening on [\d.]+:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('proxy exited: ' + code)); });
  });

  // PORT=0 asks the OS for a free port, so read the real one back from the log line.
  return { child, base: 'http://127.0.0.1:' + port };
}

before(async () => {
  mock = createMockUpstream();
  upstreamPort = await mock.listen(0);
});

after(async () => {
  for (const child of running) child.kill('SIGTERM');
  await mock.close();
});

/* ------------------------------------------------------------------- health */

test('healthz answers without auth or an allowed origin', async () => {
  const { base } = await startProxy({ ALLOWED_ORIGINS: 'https://example.com' });
  const res = await fetch(base + '/healthz');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

/* --------------------------------------------------------------------- cors */

test('preflight returns 204 with the headers a browser needs', async () => {
  const { base } = await startProxy();
  const res = await fetch(base + '/chat/completions', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://study.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type,x-opencode-session'
    }
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://study.example');
  const allowed = res.headers.get('access-control-allow-headers').toLowerCase();
  for (const header of ['authorization', 'content-type', 'x-opencode-session']) {
    assert.ok(allowed.includes(header), 'preflight must allow ' + header);
  }
});

test('a file:// page (Origin: null) is echoed, not given a wildcard', async () => {
  const { base } = await startProxy();
  const res = await fetch(base + '/chat/completions', {
    method: 'OPTIONS',
    headers: { origin: 'null', 'access-control-request-method': 'POST' }
  });
  assert.equal(res.headers.get('access-control-allow-origin'), 'null');
});

test('an origin outside the allowlist is refused', async () => {
  const { base } = await startProxy({ ALLOWED_ORIGINS: 'https://allowed.example' });
  const blocked = await fetch(base + '/models', {
    headers: { origin: 'https://evil.example', authorization: 'Bearer k' }
  });
  assert.equal(blocked.status, 403);

  const ok = await fetch(base + '/models', {
    headers: { origin: 'https://allowed.example', authorization: 'Bearer k' }
  });
  assert.equal(ok.status, 200);
});

/* -------------------------------------------------------------------- token */

test('with PROXY_TOKEN set, a request without the token is rejected', async () => {
  const { base } = await startProxy({ PROXY_TOKEN: 's3cret' });

  const without = await fetch(base + '/models', { headers: { authorization: 'Bearer k' } });
  assert.equal(without.status, 401);

  const wrong = await fetch(base + '/models', {
    headers: { authorization: 'Bearer k', 'x-proxy-token': 'nope' }
  });
  assert.equal(wrong.status, 401);

  const right = await fetch(base + '/models', {
    headers: { authorization: 'Bearer k', 'x-proxy-token': 's3cret' }
  });
  assert.equal(right.status, 200);
});

/* ------------------------------------------------------------------ routing */

test('the session header is supplied when the caller omits it', async () => {
  const { base } = await startProxy();
  const res = await fetch(base + '/models', { headers: { authorization: 'Bearer k' } });
  assert.equal(res.status, 200, 'upstream 400s when the session header is missing');

  const last = mock.seen.at(-1);
  assert.ok(last.headers['x-opencode-session'], 'proxy must supply a session id');
});

test('a caller-supplied session id is forwarded unchanged', async () => {
  const { base } = await startProxy();
  await fetch(base + '/models', {
    headers: { authorization: 'Bearer k', 'x-opencode-session': 'my-conversation-1' }
  });
  assert.equal(mock.seen.at(-1).headers['x-opencode-session'], 'my-conversation-1');
});

test('the Authorization header reaches the upstream untouched', async () => {
  const { base } = await startProxy();
  await fetch(base + '/models', { headers: { authorization: 'Bearer oc_sk_example' } });
  assert.equal(mock.seen.at(-1).headers.authorization, 'Bearer oc_sk_example');
});

test('a real user-agent is sent, not a library default', async () => {
  const { base } = await startProxy();
  await fetch(base + '/models', { headers: { authorization: 'Bearer k' } });
  const ua = mock.seen.at(-1).headers['user-agent'];
  assert.match(ua, /opencode-cors-proxy/);
});

test('a request with no Authorization is rejected before reaching the upstream', async () => {
  const { base } = await startProxy();
  const before = mock.seen.length;
  const res = await fetch(base + '/models');
  assert.equal(res.status, 401);
  assert.equal(mock.seen.length, before, 'must not forward an unauthenticated request');
});

test('paths outside the API surface are not proxied', async () => {
  const { base } = await startProxy();
  const res = await fetch(base + '/../etc/passwd', { headers: { authorization: 'Bearer k' } });
  assert.equal(res.status, 404);
});

/* ---------------------------------------------------------------- streaming */

test('SSE streams through and is marked unbuffered for Cloudflare', async () => {
  const { base } = await startProxy();
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], stream: true })
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  assert.match(res.headers.get('cache-control'), /no-transform/);

  const text = await res.text();
  assert.ok(text.includes('Hello'), 'stream body should arrive');
  assert.ok(text.includes('[DONE]'), 'terminating sentinel should arrive');
});

test('a non-streaming completion passes through', async () => {
  const { base } = await startProxy();
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] })
  });
  const body = await res.json();
  assert.equal(body.choices[0].message.content, 'Hello world');
});

/* --------------------------------------------------------------- protection */

test('an oversized body is refused', async () => {
  const { base } = await startProxy({ MAX_BODY_BYTES: '500' });
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(5000) })
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.match(body.error.message, /too large/i);
});

test('the rate limit returns 429 once the window is spent', async () => {
  const { base } = await startProxy({ RATE_LIMIT: '3', RATE_WINDOW_MS: '60000' });
  const codes = [];
  for (let i = 0; i < 5; i += 1) {
    const res = await fetch(base + '/models', { headers: { authorization: 'Bearer k' } });
    codes.push(res.status);
  }
  assert.deepEqual(codes.slice(0, 3), [200, 200, 200]);
  assert.equal(codes[3], 429);
  assert.equal(codes[4], 429);
});

test('rate limiting keys on CF-Connecting-IP so one visitor cannot spend everyone else quota', async () => {
  const { base } = await startProxy({ RATE_LIMIT: '2', RATE_WINDOW_MS: '60000' });
  const call = (ip) => fetch(base + '/models', {
    headers: { authorization: 'Bearer k', 'cf-connecting-ip': ip }
  });

  assert.equal((await call('1.1.1.1')).status, 200);
  assert.equal((await call('1.1.1.1')).status, 200);
  assert.equal((await call('1.1.1.1')).status, 429, 'first visitor is now limited');
  assert.equal((await call('2.2.2.2')).status, 200, 'a different visitor must be unaffected');
});

/* -------------------------------------------------------------------- hygiene */

test('the proxy never logs the Authorization header', async () => {
  const { child, base } = await startProxy();
  let output = '';
  child.stdout.on('data', (b) => { output += b.toString(); });
  child.stderr.on('data', (b) => { output += b.toString(); });

  await fetch(base + '/models', { headers: { authorization: 'Bearer oc_sk_supersecret' } });
  await new Promise((r) => setTimeout(r, 300));

  assert.ok(!output.includes('oc_sk_supersecret'), 'key must never appear in logs');
});

test('SIGTERM shuts the process down promptly', async () => {
  const { child } = await startProxy();
  const started = Date.now();
  const exited = new Promise((resolve) => child.on('exit', resolve));
  child.kill('SIGTERM');
  await exited;
  assert.ok(Date.now() - started < 5000, 'should exit well before a SIGKILL timeout');
});

/* Integration tests against the built image, not the source.
 * Requires: docker build -t opencode-cors-proxy . (compose build does this) */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';

const NAME = 'opencode-proxy-itest';
const PORT = 18787;
let container;

function sh(args) {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

before(async () => {
  try { sh(['rm', '-f', NAME]); } catch { /* not running */ }
  container = sh([
    'run', '-d', '--name', NAME,
    '-p', '127.0.0.1:' + PORT + ':8787',
    '-e', 'ALLOWED_ORIGINS=https://allowed.example',
    '-e', 'PROXY_TOKEN=itest-token',
    '-e', 'RATE_LIMIT=1000',
    'opencode-cors-proxy'
  ]);
  // Wait for the health route rather than sleeping a fixed amount.
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/healthz');
      if (res.ok) return;
    } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('container did not become healthy');
});

after(() => {
  try { sh(['rm', '-f', NAME]); } catch { /* already gone */ }
});

const base = 'http://127.0.0.1:' + PORT;

test('container serves /healthz', async () => {
  const res = await fetch(base + '/healthz');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.upstream, /opencode\.ai/);
});

test('container enforces the origin allowlist', async () => {
  const res = await fetch(base + '/models', {
    headers: { origin: 'https://evil.example', authorization: 'Bearer k', 'x-proxy-token': 'itest-token' }
  });
  assert.equal(res.status, 403);
});

test('container enforces the proxy token', async () => {
  const res = await fetch(base + '/models', {
    headers: { origin: 'https://allowed.example', authorization: 'Bearer k' }
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(body.error.message, /x-proxy-token/);
});

test('container preflight advertises the needed headers', async () => {
  const res = await fetch(base + '/chat/completions', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://allowed.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type,x-opencode-session'
    }
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://allowed.example');
  assert.match(res.headers.get('access-control-allow-headers').toLowerCase(), /x-opencode-session/);
});

test('container reaches the real opencode API and adds CORS to its reply', async () => {
  const res = await fetch(base + '/models', {
    headers: {
      origin: 'https://allowed.example',
      authorization: 'Bearer not-a-real-key',
      'x-proxy-token': 'itest-token'
    }
  });
  // A rejected key proves the request reached opencode; the CORS header is what
  // upstream never sends and the proxy exists to add.
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://allowed.example');
  assert.ok([200, 401, 403].includes(res.status), 'unexpected upstream status ' + res.status);
});

test('container stops promptly on SIGTERM rather than waiting for SIGKILL', () => {
  const started = Date.now();
  sh(['stop', NAME]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 9000, 'docker stop took ' + elapsed + 'ms, suggesting SIGTERM was ignored');
});

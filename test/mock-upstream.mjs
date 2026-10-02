/* A stand-in for the opencode Zen API.
 *
 * It reproduces the two behaviours that matter: it rejects a request with no
 * x-opencode-session the way opencode does, and it streams SSE chunks. Having it means the
 * whole proxy chain is testable with no API key and no network. */

import { createServer } from 'node:http';

export function createMockUpstream() {
  const seen = [];

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body
      });

      if (!req.headers.authorization) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key.' } }));
        return;
      }

      // The real failure that prompted this: opencode 400s without a conversation id.
      if (!req.headers['x-opencode-session']) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: { message: 'Request is missing x-opencode-session and cannot be routed efficiently.' }
        }));
        return;
      }

      if (req.url.startsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'glm-5.3', object: 'model' }, { id: 'kimi-k3', object: 'model' }]
        }));
        return;
      }

      if (req.url.startsWith('/chat/completions')) {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* exercised by the bad-json test */ }

        if (parsed.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const frame = (content) => 'data: ' + JSON.stringify({
            choices: [{ delta: { content }, index: 0 }]
          }) + '\n\n';
          res.write(frame('Hello'));
          res.write(frame(' world'));
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Hello world' }, finish_reason: 'stop' }]
        }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'No such upstream path' } }));
    });
  });

  return {
    server,
    seen,
    listen(port = 0) {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

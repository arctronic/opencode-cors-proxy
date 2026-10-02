# opencode-cors-proxy

A small proxy for the [opencode Zen API](https://opencode.ai/docs/go/).

It does two jobs: it makes opencode callable from a **browser page** (which CORS otherwise
forbids), and it makes opencode usable from **Claude Code** (which cannot send the
conversation-id header opencode requires).

## Why this exists

opencode's API cannot be called from a web page:

| | Preflight (`OPTIONS`) | Actual response |
|---|---|---|
| `POST /chat/completions` | **404** | no `Access-Control-Allow-Origin` |
| `GET /models` | 200 with `ACAO: *` | **no** `Access-Control-Allow-Origin` |

A browser enforces CORS against the *response* headers, so it discards replies that lack
them. No client SDK changes this, because any library sending the same request is blocked
the same way. This proxy sits in front and supplies what is missing.

It also handles two protocol requirements that are easy to miss:

- opencode returns `400 Request is missing x-opencode-session` without a conversation id.
  The proxy forwards the caller's, or supplies one.
- opencode asks clients to send a real user agent, and browsers forbid JavaScript from
  setting `user-agent`. The proxy sets it.

**No API key is stored.** The caller's `Authorization` header is forwarded upstream as-is,
nothing is written to disk, and the key is never logged.

## Run locally

```bash
docker compose up -d          # http://127.0.0.1:8787
docker compose logs -f
docker compose down
```

Or without Docker: `npm start`.

Point your app's API base URL at the proxy instead of `https://opencode.ai/zen/go/v1`.

## Deploy on EasyPanel

1. Push this directory to its own Git repository.
2. EasyPanel → **Create Service** → **App** → point it at the repo.
3. Build method: **Dockerfile**. Nothing else to configure; there are no dependencies.
4. Set the **port** to `8787`.
5. Add the environment variables below.
6. Attach your domain. EasyPanel routes to the container and terminates TLS in front of it,
   so the proxy itself only ever speaks plain HTTP inside the network.

Do **not** publish a host port on EasyPanel, since the platform handles routing. The port
mapping in `compose.yml` is for local use only.

Health check path: `/healthz` (unauthenticated, no API key needed).

## Behind Cloudflare

Proxied DNS (orange cloud) gives you TLS at the edge. Two things are worth knowing:

- **Streaming.** Token streaming arrives as `text/event-stream`, and a reverse proxy will
  buffer that into one lump unless told otherwise, turning a live stream into a long
  silence followed by a wall of text. The proxy sets `cache-control: no-cache, no-transform` and
  `x-accel-buffering: no` on streamed responses to prevent that.
- **The 100-second limit.** Cloudflare's free plan drops a connection after 100s with a
  524. A long non-streamed completion can exceed that. Send `stream: true` and the first
  token arrives almost immediately, which keeps the connection alive.

Rate limiting uses `CF-Connecting-IP`, which Cloudflare sets itself, so one visitor cannot
spend everyone else's allowance. Lock your origin to Cloudflare IPs so that header cannot
be forged.

## Use it from Claude Code

Claude Code speaks the Anthropic Messages API, and opencode serves that natively at
`/zen/go/v1/messages` - so no format translation is needed. The one blocker is that opencode
rejects any request without `x-opencode-session`, and Claude Code does not send one. Pointing
Claude Code at this proxy fixes that, because the proxy supplies the header.

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8787"   # or your deployed proxy URL
$env:ANTHROPIC_API_KEY  = "oc_sk_your_key"
$env:ANTHROPIC_MODEL    = "kimi-k3"
```

`ANTHROPIC_BASE_URL` omits `/v1` - the client appends `/v1/messages` itself.

Use `ANTHROPIC_API_KEY`, not `ANTHROPIC_AUTH_TOKEN`: that endpoint authenticates with
`x-api-key`, and `Authorization: Bearer` returns `Missing API key`. The proxy accepts either
and forwards whichever you sent.

Verified working with tool calling, which Claude Code depends on:

```
model: kimi-k3   stop_reason: tool_use   read_file {"path": "/etc/hosts"}
```

Caveats worth knowing:

- **Not every model speaks the Anthropic protocol.** `glm-5.3` returns
  `ModelProtocolUnsupported` on `/messages` while working fine on `/chat/completions`.
  Confirmed working: `kimi-k3`, `deepseek-v4-pro`, `space-bunny-free`.
- **This is unsupported territory.** Pointing Claude Code at a non-Anthropic backend is not
  an official configuration - Bedrock and Vertex are. Expect rough edges around prompt
  caching, long context and newer features, and check it is within your opencode plan terms.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8787` | Listen port. EasyPanel may set this for you. |
| `HOST` | `0.0.0.0` | Bind address. |
| `UPSTREAM` | `https://opencode.ai/zen/go/v1` | The API being fronted. |
| `ALLOWED_ORIGINS` | `*` | Comma-separated origins allowed to call the proxy. |
| `PROXY_TOKEN` | *(unset)* | When set, callers must send it as `x-proxy-token`. |
| `RATE_LIMIT` | `60` | Requests per window per IP. `0` disables. |
| `RATE_WINDOW_MS` | `60000` | Length of the rate-limit window. |
| `MAX_BODY_BYTES` | `1000000` | Largest accepted request body. |
| `USER_AGENT` | `opencode-cors-proxy/1.0` | Sent upstream. |

Copy `.env.example` to `.env.local` (or `.env`) to set these locally. Both are gitignored;
only `.env.example` is committed.

Your opencode API key does **not** go in any of them - the proxy stores no key. Each caller
sends their own and it is forwarded upstream as-is.

### Securing a public deployment

A CORS proxy on a public host is an **open relay** by default: any website can point at it.
A caller still needs their own opencode key, so nobody spends *your* quota, but your host
carries the traffic and your IP wears the reputation. Before exposing it:

- Set `ALLOWED_ORIGINS` to the exact origins of your app. Not `*`.
- Set `PROXY_TOKEN` to a random secret your app sends as `x-proxy-token`:
  ```bash
  node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
  ```
- Keep `RATE_LIMIT` on.

The server logs a warning at startup if `ALLOWED_ORIGINS` is `*` and no `PROXY_TOKEN` is
set.

Only `/chat/completions`, `/models`, `/responses` and `/messages` are proxied; anything else
returns 404, so the proxy cannot be used to reach arbitrary upstream paths.

## Tests

```bash
npm test            # 22 tests against a mock upstream, no API key needed
npm run test:docker # 6 tests against the built image, including a live opencode call
```

The mock upstream in `test/mock-upstream.mjs` reproduces the two behaviours that matter -
rejecting a missing session header, and streaming SSE, so the whole chain is covered
without a key or a network round trip. The Docker suite spawns the real image, checks the
origin allowlist, token gate, preflight and shutdown behaviour, and confirms a real call to
opencode comes back carrying the CORS header upstream never sends.

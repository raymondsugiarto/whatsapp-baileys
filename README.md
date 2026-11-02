# receivable-wa

Standalone WhatsApp Web service built on
[Baileys](https://github.com/WhiskeySockets/Baileys). Any system can use it
over its HTTP API: link a WhatsApp number by QR (one **session** per number),
send messages, and receive incoming messages and link status by webhook.
`receivable-api` is one such client.

It has its **own Postgres database** (e.g. `whatsapp`) and never reads a
client's tables. Its tables are created on startup (`src/schema.ts`).

## HTTP API

Every call is signed both ways with a shared secret (`WA_SIDECAR_SECRET`):
header `X-Signature-256: sha256=<hex HMAC-SHA256(secret, raw body)>`
(`GET` signs the empty string).

| Route                              | Body              | Returns                              |
| ---------------------------------- | ----------------- | ------------------------------------ |
| `POST /sessions/:sessionId/start`  | —                 | `{status, qr, phone}`                |
| `GET  /sessions/:sessionId`        | —                 | `{status, qr, phone}`                |
| `POST /sessions/:sessionId/logout` | —                 | 204                                  |
| `POST /sessions/:sessionId/send`   | `{to, text}`      | `{messageId}`; 409 if not connected  |
| `POST /sessions/:sessionId/read`   | `{remoteJid, id}` | 204                                  |
| `GET  /health`                     | (unsigned)        | `{status: "ok"}`                     |

`:sessionId` is any id the client picks (receivable-api uses an
organization id, or `platform`). `status` is `disconnected`, `connecting`,
`qr` (then `qr` is a PNG `data:` URL), `connected` or `logged_out`.

Webhooks go to the client at `WA_API_BASE_URL`, signed the same way:

- `POST /api/v1/internal/whatsapp/inbound`
  `{organizationId, remoteJid, from, name, messageId, type, text}`
- `POST /api/v1/internal/whatsapp/status` `{organizationId, status, phone}`

(`organizationId` carries the session id; the name is kept for
receivable-api.) On restart every session that still has a login reconnects
by itself.

How receivable-api uses it: `receivable-api/docs/whatsapp-baileys.md`.

## Moving logins from the old shared database

Before this service had its own database, logins sat in the receivable
database (`receivable.wa_auth_state`). Copy them once so linked numbers keep
working without a new QR (stop the service first; safe to repeat):

```bash
WA_COPY_FROM_URL=postgres://user:pass@host:5432/finance WA_COPY_FROM_SCHEMA=receivable pnpm copy-auth
```

## Run locally

Node 20+ (`.nvmrc` = 22) and a Postgres database for this service:

```bash
cp .env.example .env   # secret, client URL, own database URL
pnpm install
pnpm dev               # :4020
pnpm test
```

## Deploy (Docker + Portainer)

| File | What it does |
| --- | --- |
| `Dockerfile` | Node 22 alpine image, non-root, runs `dist/index.js` on :4020 |
| `docker-compose.yml` | The Portainer stack: one replica, no published port, `platform` network |
| `stack.env.example` | The stack's variables: secret, client URL, its own `WA_DATABASE_*` |
| `.github/workflows/ci.yml` | Type-check, tests and build on pushes and PRs |
| `.github/workflows/publish.yml` | Builds `ghcr.io/<owner>/receivable-wa`, then redeploys the stack |

One-time setup:

1. In Portainer, create a stack named `receivable-wa` from
   `docker-compose.yml` on the same endpoint and `platform` network as
   receivable-api. Fill in its variables from `stack.env.example`;
   `WA_SIDECAR_SECRET` must equal the API stack's `WHATSAPP_SIDECAR_SECRET`.
2. Add repo secrets for `publish.yml`: `PORTAINER_URL`,
   `PORTAINER_USERNAME`, `PORTAINER_PASSWORD`, `PORTAINER_ENDPOINT_ID` and
   `PORTAINER_STACK_ID` (this stack's id, not the API's).
3. Push to `main`. After the first push, make sure the Portainer host can
   pull the new `ghcr.io/<owner>/receivable-wa` package (same registry
   credentials as receivable-api, or make the package public).

The API stack reaches it at `WHATSAPP_SIDECAR_BASEURL=http://receivable-wa:4020`.

Internal only: never publish its port, and run exactly one instance (two
instances on the same login knock each other off WhatsApp).

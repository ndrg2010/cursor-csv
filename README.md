# Cursor CSV Middleware

Multi-org Cursor CSV middleware for Salesforce. Downloads ContentVersion files, parses them with DuckDB, and exposes a paginated row-range REST API so the [CursorBatch Framework](https://github.com/ndrg2010/cursor-batch-framework) can process CSV data without hitting heap limits.

Supports multiple Salesforce orgs via self-registration — each org installs the cursor-batch-framework package (which includes an External Client App), then registers with the middleware through a setup tab. No per-org server configuration required.

## Quick Start

```bash
cp .env.example .env
# Set ECA_CLIENT_ID, ECA_CLIENT_SECRET, and ADMIN_API_KEY
npm install
npm start
```

## Onboarding a New Org

1. Install the cursor-batch-framework package in the Salesforce org (the ECA installs automatically)
2. Assign the Run As user and permissions for the ECA in SF Setup
3. Open the **CSV Middleware Setup** tab in the app
4. Enter the middleware URL and click **Register**
5. The setup tab calls `POST /v1/orgs` with the org's login URL
6. The middleware validates by test-authenticating, then returns an org-specific API key
7. Done — Queueable Apex uses the API key for all CSV requests

## API

### Org Management (requires `ADMIN_API_KEY`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/orgs` | Register a new org (body: `{ loginUrl, label? }`) |
| `GET` | `/v1/orgs` | List all registered orgs |
| `DELETE` | `/v1/orgs/:orgId` | Remove a registered org |
| `POST` | `/v1/orgs/:orgId/rotate-key` | Rotate an org's API key |

### CSV Operations (requires per-org `X-API-Key`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/csv/init` | Start a Cursor CSV session (body: `{ contentVersionId, callbackUrl? }`) |
| `GET` | `/v1/csv/:csvQueryId/status` | Poll session status (`preparing` / `ready` / `error`) |
| `GET` | `/v1/csv/:csvQueryId/rows?start=N&count=N` | Fetch paginated rows |
| `GET` | `/v1/csv/:csvQueryId/meta` | Get session metadata (headers, types, row count) |
| `DELETE` | `/v1/csv/:csvQueryId` | Delete session and release resources |
| `GET` | `/health` | Health check (no auth required) |

## Docker

```bash
docker compose up --build
```

## Architecture

- **Multi-org** self-registration via `/v1/orgs` API
- **Shared ECA credentials** (set once in `.env`) combined with per-org login URLs
- **Fastify** for high-throughput HTTP
- **DuckDB** per-session in-memory instances for fast columnar row queries
- **OAuth 2.0 Client Credentials** flow for Salesforce file downloads
- Async init pattern to avoid Salesforce's 120-second callout timeout
- Optional **callback notification** — provide a `callbackUrl` at init time and skip polling
- Sliding-window TTL with configurable expiration (default 15 minutes)
- Org registrations persisted to JSON file on Docker volume

## Testing

```bash
npm test
```

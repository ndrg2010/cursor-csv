# Cursor CSV Middleware — Technical Summary

**Status:** Draft  
**Repository:** [cursor-csv-middleware](https://github.com/ndrg2010/cursor-csv)  
**Related:** [cursor-batch-framework](https://github.com/ndrg2010/cursor-batch-framework)

---

## Overview

The Cursor CSV Middleware is a standalone Node.js service that enables the [cursor-batch-framework](https://github.com/ndrg2010/cursor-batch-framework) to process CSV files stored in Salesforce without hitting Apex heap or callout limits. It downloads ContentVersion files from Salesforce, parses them with DuckDB (an in-memory columnar database), and exposes a paginated REST API that Queueable Apex jobs can consume in small, heap-safe row batches.

### Problem It Solves

Salesforce Apex has hard governor limits on heap size (12 MB async) and callout response size. Parsing a large CSV entirely in Apex is not feasible. The cursor-batch-framework already solves this for SOQL via database cursors, but CSV files (stored as ContentVersion records) had no equivalent paging mechanism — until now.

### How It Works

1. Apex calls `POST /v1/csv/init` with a ContentVersion ID
2. The middleware downloads the file from Salesforce via the REST API (OAuth 2.0 Client Credentials flow)
3. DuckDB ingests the CSV into an in-memory table
4. The middleware publishes a `CSV_Session_Ready__e` Platform Event to the originating org (status = `ready` or `error`)
5. Apex fetches rows in pages via `GET /v1/csv/:csvQueryId/rows?start=0&count=200`
6. When done, Apex calls `DELETE /v1/csv/:csvQueryId` to release resources

The `GET /v1/csv/:csvQueryId/status` polling endpoint remains available as a fallback if the Platform Event is not deployed in the org.

The init endpoint returns immediately (HTTP 202) to avoid Salesforce's 120-second callout timeout. Download and parsing happen asynchronously on the server side.

### Response Format

Rows are returned as **parsed JSON objects**, not raw CSV text. DuckDB parses the CSV and returns each row as a key/value object keyed by column name. All values are returned as strings (`all_varchar=true` in DuckDB) so Apex deserialization stays predictable — the consuming Apex code knows the target SObject field types and handles casting.

Example response from `GET /v1/csv/:csvQueryId/rows?start=0&count=3`:

```json
{
  "csvQueryId": "cq_abc123...",
  "start": 0,
  "count": 3,
  "totalRows": 10,
  "hasMore": true,
  "rows": [
    { "Id": "001a", "Name": "Acme Deal", "Amount": "50000", "Stage": "Closed Won" },
    { "Id": "001b", "Name": "Beta Deal", "Amount": "75000", "Stage": "Negotiation" },
    { "Id": "001c", "Name": "Gamma Deal", "Amount": "30000", "Stage": "Prospecting" }
  ]
}
```

### Platform Event Callback

When a session reaches a terminal state (`ready` or `error`), the middleware publishes a `CursorBatch_Coordinator__e` Platform Event to the originating org. This is the same coordinator event used by the cursor-batch-framework, so it requires no additional custom metadata in the org. The Apex-side coordinator class (`CSV_Ready`) receives the event and queries the middleware's status endpoint for full session details.

**Platform Event:** `CursorBatch_Coordinator__e` (configurable via `CALLBACK_PLATFORM_EVENT`)

**Published payload:**

```json
{
  "Job_Record_Id__c": "cq_abc123...",
  "Coordinator_Class__c": "CSV_Ready"
}
```

The payload is identical for both `ready` and `error` outcomes — the coordinator class queries the middleware's `/v1/csv/:csvQueryId/status` endpoint to determine the result and retrieve row counts or error details.

**Graceful degradation:** If the Platform Event is not deployed in the org, the middleware logs a warning on the first attempt and suppresses future callbacks for that org. The status polling endpoint continues to work as a fallback.

**Reliability:** Callbacks retry once with a 2-second delay on any non-404 failure. They are fire-and-forget — a failed callback does not affect session readiness.

**Salesforce prerequisite:** The org must have the `CursorBatch_Coordinator__e` Platform Event (included in the cursor-batch-framework managed package) with fields `Job_Record_Id__c` (Text) and `Coordinator_Class__c` (Text).

---

## Architecture

```
┌─────────────────────┐          ┌──────────────────────────────────┐
│   Salesforce Org     │          │   Cursor CSV Middleware           │
│                      │          │                                  │
│  Queueable Apex      │──REST──▶│  Fastify HTTP Server (port 3000) │
│  (cursor-batch-      │  API    │                                  │
│   framework)         │◀────────│  ┌────────────┐  ┌────────────┐  │
│                      │         │  │  Session    │  │  Org       │  │
│  ContentVersion      │         │  │  Manager    │  │  Registry  │  │
│  (CSV files)         │◀─OAuth──│  └─────┬──────┘  └────────────┘  │
│                      │  2.0    │        │                         │
│  External Client App │         │  ┌─────▼──────┐                  │
│  (ECA)               │         │  │  DuckDB    │                  │
└─────────────────────┘          │  │  (in-mem)  │                  │
                                 │  └────────────┘                  │
                                 └──────────────────────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Async init pattern** | Salesforce enforces a 120-second callout timeout. Large CSVs can take time to download and parse, so init returns 202 immediately and Apex polls for readiness. |
| **DuckDB per session** | Each CSV session gets its own in-memory DuckDB instance. This provides fast columnar row-range queries (`LIMIT/OFFSET`) without writing a custom parser, and isolates sessions from each other. |
| **Sliding-window TTL** | Sessions expire after 15 minutes of inactivity (configurable). Each row fetch resets the timer so long-running batch jobs don't lose their session mid-processing. |
| **Multi-org via self-registration** | No per-org server config required. Each org installs the managed package (which includes the ECA), then self-registers via a setup tab. The middleware validates by test-authenticating. |
| **Shared ECA credentials** | The External Client App is part of the managed package, so the client ID and secret are the same across all orgs. Only the login URL varies per org. |
| **API keys hashed at rest** | Org API keys are SHA-256 hashed before storage. The raw key is returned exactly once at registration time. |
| **Streaming download** | CSV files are streamed from Salesforce to disk via Node.js streams, then loaded into DuckDB. The file is never buffered entirely in Node.js memory. |
| **Platform Event callback** | When a session reaches `ready` or `error`, the middleware publishes a `CursorBatch_Coordinator__e` Platform Event to the originating org, reusing the cursor-batch-framework's coordinator channel. The Apex coordinator class queries back for details. Gracefully degrades if the PE is not deployed. |

---

## Multi-Org Model

The middleware supports multiple Salesforce orgs without per-org server configuration. Each org goes through a one-time onboarding flow:

1. Install the `cursor-batch-framework` managed package (the External Client App installs automatically)
2. Assign the Run As user and permissions for the ECA in Salesforce Setup
3. Open the **CSV Middleware Setup** tab in the Salesforce app
4. Enter the middleware URL and click **Register**
5. The setup tab calls `POST /v1/orgs` with the org's login URL
6. The middleware validates by test-authenticating with the shared ECA credentials against that org's login URL
7. Returns an org-specific API key (`csvmw_...`)
8. The Queueable Apex jobs use that API key for all subsequent CSV requests

Orgs are fully isolated — sessions created by one org cannot be accessed or deleted by another.

---

## REST API

### Org Management (admin-only, requires `ADMIN_API_KEY` via `X-API-Key` header)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/orgs` | Register a new org. Body: `{ loginUrl, label? }`. Returns `{ orgId, apiKey, label }`. |
| `GET` | `/v1/orgs` | List all registered orgs (no secrets exposed). |
| `DELETE` | `/v1/orgs/:orgId` | Remove a registered org. |
| `POST` | `/v1/orgs/:orgId/rotate-key` | Rotate an org's API key. Returns new key. |

### CSV Operations (per-org, requires org `X-API-Key` header)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/csv/init` | Start a Cursor CSV session. Body: `{ contentVersionId }`. Returns 202 with `csvQueryId`. The middleware automatically publishes a Platform Event when the session is ready or errors. |
| `GET` | `/v1/csv/:csvQueryId/status` | Poll session status: `preparing`, `ready`, or `error`. |
| `GET` | `/v1/csv/:csvQueryId/rows` | Fetch paginated rows. Query params: `start` (0-based offset), `count` (max 2000). |
| `GET` | `/v1/csv/:csvQueryId/meta` | Get session metadata: headers, column types, row count. |
| `DELETE` | `/v1/csv/:csvQueryId` | Delete session and release DuckDB resources. |

### Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Basic health check. |
| `GET` | `/health/detail` | Admin | Active sessions, memory usage, max sessions. |

---

## Technology Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Node.js | >= 20.0.0 |
| HTTP framework | Fastify | 5.x |
| CSV parsing / query engine | DuckDB (Node API) | 1.5.x |
| Rate limiting | @fastify/rate-limit | 10.x |
| Auth | OAuth 2.0 Client Credentials flow (Salesforce ECA) | — |
| Container | Docker (multi-stage build, Node 20-slim) | — |
| Test runner | Node.js built-in test runner (`node:test`) | — |

**Zero database dependencies** — the middleware is stateless aside from a JSON file on a Docker volume for org registrations. DuckDB instances are ephemeral and in-memory.

---

## Security

- **Two-tier auth:** Admin endpoints use a static `ADMIN_API_KEY`. CSV endpoints use per-org API keys issued at registration.
- **API keys hashed at rest:** SHA-256 hash stored in `orgs.json`; raw key returned once at registration.
- **Key rotation:** `POST /v1/orgs/:orgId/rotate-key` issues a new key and invalidates the old one.
- **Constant-time comparison:** Admin key checks use `crypto.timingSafeEqual` to prevent timing attacks.
- **Salesforce domain validation:** `POST /v1/orgs` validates that `loginUrl` matches known Salesforce domain patterns (`*.my.salesforce.com`, `*.salesforce.com`, `*.force.com`, `*.cloudforce.com`, `*.salesforce.mil`, `*.sfcrmapps.cn`).
- **Cross-org session isolation:** Sessions are tagged with `orgId`; all CSV endpoints enforce ownership checks.
- **Rate limiting:** 100 requests/minute per IP globally, 20 requests/minute for `/v1/csv/init`.
- **File size limit:** Configurable max CSV size (default 100 MB) enforced during streaming download.
- **Path traversal prevention:** CSV import validates that file paths stay within the configured temp directory.
- **Non-root container:** Docker image runs as `appuser`, not root.
- **File permissions:** `orgs.json` written with mode `0o600`.
- **Request IDs:** Every response includes `x-request-id` for traceability.

---

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `LOG_LEVEL` | `info` | Pino log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`) |
| `ADMIN_API_KEY` | — | Static key for org management endpoints (required in production) |
| `ECA_CLIENT_ID` | — | **Required.** Salesforce External Client App consumer key |
| `ECA_CLIENT_SECRET` | — | **Required.** Salesforce External Client App consumer secret |
| `SF_API_VERSION` | `62.0` | Salesforce REST API version |
| `SF_FETCH_TIMEOUT_MS` | `30000` | Timeout for Salesforce HTTP requests |
| `DATA_DIR` | `./data` | Directory for persistent org registry file |
| `TMP_DIR` | `./tmp` | Directory for temporary CSV downloads |
| `CSV_TTL_SECONDS` | `900` | Session TTL (sliding window, 15 min default) |
| `MAX_CONCURRENT_SESSIONS` | `10` | Maximum active CSV sessions |
| `MAX_ROW_FETCH` | `2000` | Maximum rows per `/rows` request |
| `MAX_CSV_SIZE_BYTES` | `104857600` | Maximum CSV file size (100 MB) |
| `CALLBACK_ENABLED` | `true` | Enable Platform Event publishing on session completion |
| `CALLBACK_PLATFORM_EVENT` | `CursorBatch_Coordinator__e` | Salesforce Platform Event API name to publish |

### Memory Budget

`MAX_CSV_SIZE_BYTES * MAX_CONCURRENT_SESSIONS * ~2` (DuckDB overhead) should stay under the container memory limit. With defaults: 100 MB x 10 x 2 = ~2 GB, leaving headroom within the 4 GB Docker container limit.

---

## Deployment

The service ships as a Docker container via `docker compose up --build`.

- **Multi-stage Docker build** — production image uses `node:20-slim` with only production dependencies
- **Health check** built into the Dockerfile (`curl -f http://localhost:3000/health`)
- **Docker volumes** for persistent org registry (`csv-data`) and temporary CSV files (`csv-tmp`)
- **Resource limits:** 4 GB memory, 2 CPUs (configurable in `docker-compose.yml`)
- **Graceful shutdown:** Handles `SIGTERM`/`SIGINT`, flushes org registry, closes all DuckDB sessions

---

## Testing

Tests use the Node.js built-in test runner (`node --test`) with no external test framework dependencies.

| Test Suite | Coverage |
|------------|----------|
| `test/integration.test.js` | Full API flow: health, auth, org management, CSV init/status/rows/meta/delete, cross-org isolation |
| `test/session-manager.test.js` | Session lifecycle, TTL, cleanup, concurrent session limits |
| `test/sf-auth.test.js` | OAuth token caching, refresh, error handling |
| `test/sf-download.test.js` | Streaming download, size limits, retry on 401 |
| `test/sf-callback.test.js` | Platform Event publishing, retry, 404 org-deny caching |
| `test/org-registry.test.js` | Registration, dedup, key rotation, persistence |

Run all tests:

```bash
npm test
```

---

## Source Structure

```
cursor-csv-middleware/
├── src/
│   ├── server.js              # Fastify app bootstrap, shutdown, temp file sweep
│   ├── config.js              # Environment variable parsing and validation
│   ├── plugins/
│   │   └── auth.js            # Admin and per-org API key authentication
│   ├── routes/
│   │   ├── csv.js             # CSV session endpoints (init, status, rows, meta, delete)
│   │   ├── orgs.js            # Org management endpoints (register, list, remove, rotate)
│   │   └── health.js          # Health check endpoints
│   └── services/
│       ├── session-manager.js # DuckDB session lifecycle, TTL, row queries
│       ├── sf-auth.js         # OAuth 2.0 Client Credentials token management
│       ├── sf-callback.js     # Platform Event publishing on session completion
│       ├── sf-download.js     # Streaming ContentVersion download with size limits
│       └── org-registry.js    # Multi-org registration, key hashing, persistence
├── test/                      # Integration and unit tests
├── Dockerfile                 # Multi-stage production image
├── docker-compose.yml         # Container orchestration with volumes and limits
├── .env.example               # Environment variable reference
└── package.json               # Node 20+, ESM, zero dev-dependencies in production
```

---

## Future Considerations

- **Horizontal scaling:** Currently single-instance. Session state is in-memory, so scaling out would require shared state (Redis, sticky sessions, or a gateway routing by `csvQueryId`).
- **Metrics/observability:** Add Prometheus metrics for session counts, download latency, DuckDB query times.
- **CSV transformation:** Support for column filtering, type casting, or row filtering before returning to Apex.

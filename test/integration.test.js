import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from 'fastify';
import authPlugin from '../src/plugins/auth.js';
import csvRoutes from '../src/routes/csv.js';
import orgRoutes from '../src/routes/orgs.js';
import healthRoutes from '../src/routes/health.js';
import { SessionManager } from '../src/services/session-manager.js';
import { OrgRegistry } from '../src/services/org-registry.js';
import { SfAuthManager } from '../src/services/sf-auth.js';

const TMP_DIR = join(process.cwd(), 'tmp');
const TEST_DATA_DIR = join(TMP_DIR, 'integration-data');

const TEST_CSV = `Id,Name,Amount,Stage
001a,Acme Deal,50000,Closed Won
001b,Beta Deal,75000,Negotiation
001c,Gamma Deal,30000,Prospecting
001d,Delta Deal,120000,Closed Won
001e,Epsilon Deal,200000,Qualification
001f,Zeta Deal,45000,Closed Lost
001g,Eta Deal,90000,Proposal
001h,Theta Deal,60000,Negotiation
001i,Iota Deal,150000,Closed Won
001j,Kappa Deal,35000,Prospecting`;

const ADMIN_KEY = 'test-admin-key';

const config = {
  port: 0,
  adminApiKey: ADMIN_KEY,
  dataDir: TEST_DATA_DIR,
  eca: { clientId: 'test-eca-id', clientSecret: 'test-eca-secret' },
  sf: { apiVersion: '62.0', fetchTimeoutMs: 30000 },
  csv: { ttlSeconds: 60, maxConcurrentSessions: 5, maxRowFetch: 2000 },
};

/**
 * Directly registers a test org in the registry by creating an SfAuthManager
 * and wiring it into the key index, bypassing the real SF auth validation.
 */
async function registerTestOrg(registry, loginUrl, label) {
  const sfAuth = new SfAuthManager({
    clientId: config.eca.clientId,
    clientSecret: config.eca.clientSecret,
    loginUrl,
  });
  // Use a mock fetch to allow the register() call to validate credentials
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      access_token: 'mock-token',
      instance_url: loginUrl,
      expires_in: 7200,
    }),
  });
  try {
    return await registry.register(loginUrl, label);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('Integration tests', () => {
  let app;
  let csvPath;
  let orgApiKey;

  before(async () => {
    await mkdir(TMP_DIR, { recursive: true });
    await mkdir(TEST_DATA_DIR, { recursive: true });
    csvPath = join(TMP_DIR, 'integration-test.csv');
    await writeFile(csvPath, TEST_CSV);

    app = Fastify({ logger: false });

    const orgRegistry = new OrgRegistry({
      ecaClientId: config.eca.clientId,
      ecaClientSecret: config.eca.clientSecret,
      sfApiVersion: config.sf.apiVersion,
      sfFetchTimeoutMs: config.sf.fetchTimeoutMs,
      dataDir: config.dataDir,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });

    const sessionManager = new SessionManager(config);

    app.decorate('config', config);
    app.decorate('orgRegistry', orgRegistry);
    app.decorate('sessionManager', sessionManager);
    app.register(authPlugin);
    app.register(orgRoutes, { prefix: '/v1/orgs' });
    app.register(csvRoutes, { prefix: '/v1/csv' });
    app.register(healthRoutes);
    app.setErrorHandler((error, request, reply) => {
      reply.status(error.statusCode || 500).send({
        code: error.code || 'INTERNAL_ERROR',
        message: error.message,
      });
    });
    await app.ready();

    const result = await registerTestOrg(orgRegistry, 'https://test.my.salesforce.com', 'Test Org');
    orgApiKey = result.apiKey;
  });

  after(async () => {
    await app.sessionManager.destroyAll();
    await app.close();
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.status, 'ok');
      assert.equal(typeof body.uptime, 'number');
    });
  });

  describe('Org management auth', () => {
    it('should reject org endpoints without admin key', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/orgs' });
      assert.equal(res.statusCode, 401);
    });

    it('should reject org endpoints with wrong admin key', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/orgs',
        headers: { 'x-api-key': 'wrong-key' },
      });
      assert.equal(res.statusCode, 403);
    });

    it('should accept org endpoints with correct admin key', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/orgs',
        headers: { 'x-api-key': ADMIN_KEY },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(Array.isArray(body.orgs));
      assert.ok(body.orgs.length >= 1);
    });
  });

  describe('CSV auth (per-org API key)', () => {
    it('should reject CSV requests without API key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/csv/init',
        payload: { contentVersionId: '068XXXXXXXXXXXX', cursorBatchJobId: 'a1fTEST000000001' },
      });
      assert.equal(res.statusCode, 401);
    });

    it('should reject CSV requests with wrong API key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/csv/init',
        headers: { 'x-api-key': 'wrong-key' },
        payload: { contentVersionId: '068XXXXXXXXXXXX', cursorBatchJobId: 'a1fTEST000000001' },
      });
      assert.equal(res.statusCode, 403);
    });
  });

  describe('POST /v1/csv/init validation', () => {
    it('should reject missing contentVersionId', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/csv/init',
        headers: { 'x-api-key': orgApiKey },
        payload: {},
      });
      assert.equal(res.statusCode, 400);
    });

    it('should reject contentVersionId that is too short', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/csv/init',
        headers: { 'x-api-key': orgApiKey },
        payload: { contentVersionId: 'short', cursorBatchJobId: 'a1fTEST000000001' },
      });
      assert.equal(res.statusCode, 400);
    });
  });

  describe('Full Cursor CSV flow (using createSessionFromFile)', () => {
    let csvQueryId;

    before(async () => {
      const session = await app.sessionManager.createSessionFromFile(csvPath);
      csvQueryId = session.csvQueryId;
    });

    it('should return ready status with metadata', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/csv/${csvQueryId}/status`,
        headers: { 'x-api-key': orgApiKey },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.status, 'ready');
      assert.equal(body.rowCount, 10);
      assert.deepEqual(body.headers, ['Id', 'Name', 'Amount', 'Stage']);
    });

    it('should return metadata from /meta endpoint', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/csv/${csvQueryId}/meta`,
        headers: { 'x-api-key': orgApiKey },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.rowCount, 10);
      assert.ok(body.columnTypes.length > 0);
    });

    it('should return first page of rows', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/csv/${csvQueryId}/rows?start=0&count=3`,
        headers: { 'x-api-key': orgApiKey },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.count, 3);
      assert.equal(body.hasMore, true);
      assert.equal(body.totalRows, 10);
      assert.equal(body.rows[0].Name, 'Acme Deal');
      assert.equal(body.rows[2].Name, 'Gamma Deal');
    });

    it('should return correct pagination on middle page', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/csv/${csvQueryId}/rows?start=3&count=3`,
        headers: { 'x-api-key': orgApiKey },
      });
      const body = res.json();
      assert.equal(body.count, 3);
      assert.equal(body.start, 3);
      assert.equal(body.hasMore, true);
      assert.equal(body.rows[0].Name, 'Delta Deal');
    });

    it('should return last page with hasMore=false', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/csv/${csvQueryId}/rows?start=9&count=5`,
        headers: { 'x-api-key': orgApiKey },
      });
      const body = res.json();
      assert.equal(body.count, 1);
      assert.equal(body.hasMore, false);
      assert.equal(body.rows[0].Name, 'Kappa Deal');
    });

    it('should validate query params', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/csv/${csvQueryId}/rows?start=-1&count=5`,
        headers: { 'x-api-key': orgApiKey },
      });
      assert.equal(res.statusCode, 400);
    });

    it('should return 404 for non-existent session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/csv/cq_00000000000000000000000000000000/status',
        headers: { 'x-api-key': orgApiKey },
      });
      assert.equal(res.statusCode, 404);
    });

    it('should return 409 when querying rows on a preparing session', async () => {
      const org = app.orgRegistry.getOrgByApiKey(orgApiKey);
      const session = app.sessionManager.createSession('068FAKE_VERSION_ID', org.sfAuth, org.orgId);
      assert.equal(session.status, 'preparing');

      const res = await app.inject({
        method: 'GET',
        url: `/v1/csv/${session.csvQueryId}/rows?start=0&count=5`,
        headers: { 'x-api-key': orgApiKey },
      });
      assert.equal(res.statusCode, 409);
      const body = res.json();
      assert.equal(body.code, 'SESSION_NOT_READY');

      await app.sessionManager.destroySession(session.csvQueryId);
    });

    it('should delete session', async () => {
      const session = await app.sessionManager.createSessionFromFile(csvPath);
      const id = session.csvQueryId;

      const delRes = await app.inject({
        method: 'DELETE',
        url: `/v1/csv/${id}`,
        headers: { 'x-api-key': orgApiKey },
      });
      assert.equal(delRes.statusCode, 204);

      const statusRes = await app.inject({
        method: 'GET',
        url: `/v1/csv/${id}/status`,
        headers: { 'x-api-key': orgApiKey },
      });
      assert.equal(statusRes.statusCode, 404);
    });
  });

  describe('Org management endpoints', () => {
    it('should list registered orgs without secrets', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/orgs',
        headers: { 'x-api-key': ADMIN_KEY },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(body.orgs.length >= 1);
      for (const org of body.orgs) {
        assert.equal(org.apiKey, undefined);
        assert.ok(org.orgId);
        assert.ok(org.loginUrl);
      }
    });

    it('should return 404 when deleting non-existent org', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/orgs/org_00000000',
        headers: { 'x-api-key': ADMIN_KEY },
      });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('Cross-org session isolation', () => {
    let org2ApiKey;

    before(async () => {
      const result = await registerTestOrg(
        app.orgRegistry, 'https://other-org.my.salesforce.com', 'Other Org',
      );
      org2ApiKey = result.apiKey;
    });

    it('should prevent Org B from accessing sessions created by Org A', async () => {
      const org = app.orgRegistry.getOrgByApiKey(orgApiKey);
      const session = app.sessionManager.createSession('068XXXXXXXXXXXX', org.sfAuth, org.orgId, 'a1fTEST000000001');

      // Org A can see its session
      const resA = await app.inject({
        method: 'GET',
        url: `/v1/csv/${session.csvQueryId}/status`,
        headers: { 'x-api-key': orgApiKey },
      });
      assert.equal(resA.statusCode, 200);

      // Org B gets 404 for the same session
      const resB = await app.inject({
        method: 'GET',
        url: `/v1/csv/${session.csvQueryId}/status`,
        headers: { 'x-api-key': org2ApiKey },
      });
      assert.equal(resB.statusCode, 404);

      await app.sessionManager.destroySession(session.csvQueryId);
    });

    it('should prevent Org B from deleting sessions owned by Org A', async () => {
      const org = app.orgRegistry.getOrgByApiKey(orgApiKey);
      const session = app.sessionManager.createSession('068XXXXXXXXXXXX', org.sfAuth, org.orgId, 'a1fTEST000000002');

      const resB = await app.inject({
        method: 'DELETE',
        url: `/v1/csv/${session.csvQueryId}`,
        headers: { 'x-api-key': org2ApiKey },
      });
      assert.equal(resB.statusCode, 404);

      // Session should still exist for Org A
      assert.ok(app.sessionManager.getSessionForOrg(session.csvQueryId, org.orgId));

      await app.sessionManager.destroySession(session.csvQueryId);
    });
  });
});

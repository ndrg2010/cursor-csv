import { describe, it, before, after, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OrgRegistry } from '../src/services/org-registry.js';

const TEST_DATA_DIR = join(process.cwd(), 'tmp', 'test-data');
const SILENT_LOG = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function createRegistry(overrides = {}) {
  return new OrgRegistry({
    ecaClientId: 'test-eca-id',
    ecaClientSecret: 'test-eca-secret',
    sfApiVersion: '62.0',
    sfFetchTimeoutMs: 5000,
    dataDir: TEST_DATA_DIR,
    log: SILENT_LOG,
    ...overrides,
  });
}

function mockSuccessfulAuth() {
  const original = globalThis.fetch;
  globalThis.fetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({
      access_token: 'mock-token',
      instance_url: 'https://test.my.salesforce.com',
      expires_in: 7200,
    }),
  }));
  return original;
}

describe('OrgRegistry', () => {
  before(async () => {
    await mkdir(TEST_DATA_DIR, { recursive: true });
  });

  after(async () => {
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(join(TEST_DATA_DIR, 'orgs.json'), { force: true });
  });

  describe('register', () => {
    it('should register a new org and return orgId + apiKey', async () => {
      const registry = createRegistry();
      const originalFetch = mockSuccessfulAuth();

      try {
        const result = await registry.register('https://myorg.my.salesforce.com', 'My Prod Org');

        assert.ok(result.orgId.startsWith('org_'));
        assert.ok(result.apiKey.startsWith('csvmw_'));
        assert.equal(result.label, 'My Prod Org');
        assert.equal(registry.size, 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should strip trailing slashes from loginUrl', async () => {
      const registry = createRegistry();
      const originalFetch = mockSuccessfulAuth();

      try {
        await registry.register('https://myorg.my.salesforce.com///', 'Test');
        const orgs = registry.list();
        assert.equal(orgs[0].loginUrl, 'https://myorg.my.salesforce.com');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should reject duplicate loginUrl', async () => {
      const registry = createRegistry();
      const originalFetch = mockSuccessfulAuth();

      try {
        await registry.register('https://myorg.my.salesforce.com', 'First');

        await assert.rejects(
          () => registry.register('https://myorg.my.salesforce.com', 'Second'),
          (err) => {
            assert.equal(err.code, 'ORG_ALREADY_REGISTERED');
            assert.equal(err.statusCode, 409);
            return true;
          },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should propagate auth failures', async () => {
      const registry = createRegistry();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => 'invalid_client',
      }));

      try {
        await assert.rejects(
          () => registry.register('https://bad.my.salesforce.com'),
          (err) => {
            assert.equal(err.code, 'SF_AUTH_FAILED');
            return true;
          },
        );
        assert.equal(registry.size, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('persistence', () => {
    it('should persist registrations to disk and reload', async () => {
      const registry1 = createRegistry();
      const originalFetch = mockSuccessfulAuth();

      try {
        const { orgId, apiKey } = await registry1.register('https://org1.my.salesforce.com', 'Org One');

        const registry2 = createRegistry();
        await registry2.load();

        assert.equal(registry2.size, 1);
        const org = registry2.getOrgByApiKey(apiKey);
        assert.ok(org);
        assert.equal(org.orgId, orgId);
        assert.equal(org.loginUrl, 'https://org1.my.salesforce.com');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should handle missing file on load gracefully', async () => {
      const registry = createRegistry();
      await registry.load();
      assert.equal(registry.size, 0);
    });
  });

  describe('getOrgByApiKey', () => {
    it('should return org context with sfAuth for valid key', async () => {
      const registry = createRegistry();
      const originalFetch = mockSuccessfulAuth();

      try {
        const { apiKey } = await registry.register('https://myorg.my.salesforce.com', 'Test');
        const org = registry.getOrgByApiKey(apiKey);

        assert.ok(org);
        assert.ok(org.sfAuth);
        assert.equal(org.loginUrl, 'https://myorg.my.salesforce.com');
        assert.equal(org.label, 'Test');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should return null for unknown key', () => {
      const registry = createRegistry();
      assert.equal(registry.getOrgByApiKey('csvmw_nonexistent'), null);
    });
  });

  describe('remove', () => {
    it('should remove an org and persist', async () => {
      const registry = createRegistry();
      const originalFetch = mockSuccessfulAuth();

      try {
        const { orgId, apiKey } = await registry.register('https://myorg.my.salesforce.com');
        assert.equal(registry.size, 1);

        const removed = await registry.remove(orgId);
        assert.equal(removed, true);
        assert.equal(registry.size, 0);
        assert.equal(registry.getOrgByApiKey(apiKey), null);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should return false for non-existent org', async () => {
      const registry = createRegistry();
      const removed = await registry.remove('org_nonexistent');
      assert.equal(removed, false);
    });
  });

  describe('rotateKey', () => {
    it('should generate a new API key and invalidate the old one', async () => {
      const registry = createRegistry();
      const originalFetch = mockSuccessfulAuth();

      try {
        const { orgId, apiKey: oldKey } = await registry.register('https://myorg.my.salesforce.com');

        const result = await registry.rotateKey(orgId);
        assert.ok(result);
        assert.ok(result.apiKey.startsWith('csvmw_'));
        assert.notEqual(result.apiKey, oldKey);

        assert.equal(registry.getOrgByApiKey(oldKey), null);
        assert.ok(registry.getOrgByApiKey(result.apiKey));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should return null for non-existent org', async () => {
      const registry = createRegistry();
      const result = await registry.rotateKey('org_nonexistent');
      assert.equal(result, null);
    });
  });

  describe('list', () => {
    it('should return all orgs without secrets', async () => {
      const registry = createRegistry();
      const originalFetch = mockSuccessfulAuth();

      try {
        await registry.register('https://org1.my.salesforce.com', 'Org 1');
        await registry.register('https://org2.my.salesforce.com', 'Org 2');

        const orgs = registry.list();
        assert.equal(orgs.length, 2);

        for (const org of orgs) {
          assert.ok(org.orgId);
          assert.ok(org.label);
          assert.ok(org.loginUrl);
          assert.ok(org.registeredAt);
          assert.equal(org.apiKey, undefined);
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

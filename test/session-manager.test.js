import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionManager } from '../src/services/session-manager.js';
import { SfAuthManager } from '../src/services/sf-auth.js';

const TMP_DIR = join(process.cwd(), 'tmp');

const TEST_CSV = `Id,Name,Amount,CloseDate
001xxx1,Acme Corp,50000,2026-01-15
001xxx2,Globex Inc,75000,2026-02-20
001xxx3,Initech,30000,2026-03-10
001xxx4,Umbrella Corp,120000,2026-04-05
001xxx5,Wayne Enterprises,200000,2026-05-01`;

const testConfig = {
  sf: { apiVersion: '62.0', fetchTimeoutMs: 30000 },
  csv: { ttlSeconds: 2, maxConcurrentSessions: 3, maxRowFetch: 2000 },
};

const stubSfAuth = new SfAuthManager({
  clientId: 'test', clientSecret: 'test', loginUrl: 'https://test.salesforce.com',
});

let csvPath;

describe('SessionManager', () => {
  before(async () => {
    await mkdir(TMP_DIR, { recursive: true });
    csvPath = join(TMP_DIR, 'session-test.csv');
    await writeFile(csvPath, TEST_CSV);
  });

  describe('createSessionFromFile', () => {
    it('should create a session with correct metadata', async () => {
      const mgr = new SessionManager(testConfig);
      const session = await mgr.createSessionFromFile(csvPath);

      assert.equal(session.status, 'ready');
      assert.equal(session.rowCount, 5);
      assert.deepEqual(session.headers, ['Id', 'Name', 'Amount', 'CloseDate']);
      assert.ok(session.csvQueryId.startsWith('cq_'));
      assert.equal(mgr.sessionCount, 1);

      await mgr.destroyAll();
    });

    it('should reject when max sessions reached', async () => {
      const mgr = new SessionManager(testConfig);
      await mgr.createSessionFromFile(csvPath);
      await mgr.createSessionFromFile(csvPath);
      await mgr.createSessionFromFile(csvPath);

      assert.equal(mgr.sessionCount, 3);

      await assert.rejects(
        () => mgr.createSessionFromFile(csvPath),
        (err) => {
          assert.equal(err.code, 'MAX_SESSIONS_REACHED');
          assert.equal(err.statusCode, 429);
          return true;
        },
      );

      await mgr.destroyAll();
    });
  });

  describe('queryRows', () => {
    let mgr;
    let csvQueryId;

    before(async () => {
      mgr = new SessionManager(testConfig);
      const session = await mgr.createSessionFromFile(csvPath);
      csvQueryId = session.csvQueryId;
    });

    after(async () => {
      await mgr.destroyAll();
    });

    it('should return first page of rows', async () => {
      const result = await mgr.queryRows(csvQueryId, 0, 2);

      assert.equal(result.start, 0);
      assert.equal(result.count, 2);
      assert.equal(result.totalRows, 5);
      assert.equal(result.hasMore, true);
      assert.equal(result.rows.length, 2);
      assert.equal(result.rows[0].Name, 'Acme Corp');
      assert.equal(result.rows[1].Name, 'Globex Inc');
    });

    it('should return middle page', async () => {
      const result = await mgr.queryRows(csvQueryId, 2, 2);

      assert.equal(result.start, 2);
      assert.equal(result.count, 2);
      assert.equal(result.hasMore, true);
      assert.equal(result.rows[0].Name, 'Initech');
    });

    it('should return last page with hasMore=false', async () => {
      const result = await mgr.queryRows(csvQueryId, 4, 10);

      assert.equal(result.count, 1);
      assert.equal(result.hasMore, false);
      assert.equal(result.rows[0].Name, 'Wayne Enterprises');
    });

    it('should return empty rows for out-of-range start', async () => {
      const result = await mgr.queryRows(csvQueryId, 100, 10);

      assert.equal(result.count, 0);
      assert.equal(result.hasMore, false);
      assert.deepEqual(result.rows, []);
    });

    it('should throw for non-existent session', async () => {
      try {
        await mgr.queryRows('cq_nonexistent', 0, 10);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.equal(err.code, 'SESSION_NOT_FOUND');
        assert.equal(err.statusCode, 404);
      }
    });
  });

  describe('TTL and touch', () => {
    it('should expire sessions after TTL', async () => {
      const shortTtlConfig = { ...testConfig, csv: { ...testConfig.csv, ttlSeconds: 1 } };
      const mgr = new SessionManager(shortTtlConfig);
      const session = await mgr.createSessionFromFile(csvPath);

      assert.equal(mgr.sessionCount, 1);

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 1200));

      const swept = await mgr.sweepExpired();
      assert.equal(swept, 1);
      assert.equal(mgr.sessionCount, 0);
    });

    it('should extend TTL on touch', async () => {
      const shortTtlConfig = { ...testConfig, csv: { ...testConfig.csv, ttlSeconds: 1 } };
      const mgr = new SessionManager(shortTtlConfig);
      const session = await mgr.createSessionFromFile(csvPath);

      // Touch before expiry
      await new Promise(resolve => setTimeout(resolve, 600));
      mgr.touch(session.csvQueryId);

      // Original TTL would have expired, but touch extended it
      await new Promise(resolve => setTimeout(resolve, 600));
      const swept = await mgr.sweepExpired();
      assert.equal(swept, 0, 'Should not have expired after touch');
      assert.equal(mgr.sessionCount, 1);

      await mgr.destroyAll();
    });
  });

  describe('destroySession', () => {
    it('should remove session and release resources', async () => {
      const mgr = new SessionManager(testConfig);
      const session = await mgr.createSessionFromFile(csvPath);

      assert.equal(mgr.sessionCount, 1);
      const destroyed = await mgr.destroySession(session.csvQueryId);
      assert.equal(destroyed, true);
      assert.equal(mgr.sessionCount, 0);

      // Querying destroyed session should fail
      try {
        await mgr.queryRows(session.csvQueryId, 0, 10);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.equal(err.code, 'SESSION_NOT_FOUND');
      }
    });

    it('should return false for non-existent session', async () => {
      const mgr = new SessionManager(testConfig);
      const destroyed = await mgr.destroySession('cq_nonexistent');
      assert.equal(destroyed, false);
    });
  });

  describe('queryRows on preparing session', () => {
    it('should throw SESSION_NOT_READY for a session still preparing', async () => {
      const mgr = new SessionManager(testConfig);
      const session = mgr.createSession('068FAKE_VERSION_ID', stubSfAuth);

      assert.equal(session.status, 'preparing');

      await assert.rejects(
        () => mgr.queryRows(session.csvQueryId, 0, 10),
        (err) => {
          assert.equal(err.code, 'SESSION_NOT_READY');
          assert.equal(err.statusCode, 409);
          return true;
        },
      );

      await mgr.destroyAll();
    });
  });

  describe('edge-case CSVs', () => {
    it('should handle headers-only CSV (zero data rows)', async () => {
      const mgr = new SessionManager(testConfig);
      const emptyPath = join(TMP_DIR, 'empty-test.csv');
      await writeFile(emptyPath, 'Col1,Col2,Col3\n');

      const session = await mgr.createSessionFromFile(emptyPath);

      assert.equal(session.status, 'ready');
      assert.equal(session.rowCount, 0);
      assert.deepEqual(session.headers, ['Col1', 'Col2', 'Col3']);

      const result = await mgr.queryRows(session.csvQueryId, 0, 10);
      assert.equal(result.count, 0);
      assert.equal(result.hasMore, false);
      assert.deepEqual(result.rows, []);

      await mgr.destroyAll();
    });

    it('should handle CSV with quoted fields containing commas and quotes', async () => {
      const mgr = new SessionManager(testConfig);
      const specialPath = join(TMP_DIR, 'special-test.csv');
      const specialCsv = [
        'Id,Name,Description',
        '1,"Acme, Inc.","A ""great"" company"',
        '2,Simple,No special chars',
      ].join('\n');
      await writeFile(specialPath, specialCsv);

      const session = await mgr.createSessionFromFile(specialPath);

      assert.equal(session.status, 'ready');
      assert.equal(session.rowCount, 2);
      assert.deepEqual(session.headers, ['Id', 'Name', 'Description']);

      const result = await mgr.queryRows(session.csvQueryId, 0, 10);
      assert.equal(result.rows[0].Name, 'Acme, Inc.');
      assert.equal(result.rows[0].Description, 'A "great" company');
      assert.equal(result.rows[1].Name, 'Simple');

      await mgr.destroyAll();
    });

    it('should handle a completely empty (0-byte) CSV file gracefully', async () => {
      const mgr = new SessionManager(testConfig);
      const zeroPath = join(TMP_DIR, 'zero-byte.csv');
      await writeFile(zeroPath, '');

      const session = await mgr.createSessionFromFile(zeroPath);
      assert.equal(session.status, 'ready');
      assert.equal(session.rowCount, 0);

      const result = await mgr.queryRows(session.csvQueryId, 0, 10);
      assert.equal(result.count, 0);
      assert.equal(result.hasMore, false);
      assert.deepEqual(result.rows, []);

      await mgr.destroyAll();
    });
  });

  describe('contentVersionId tracking', () => {
    it('should store contentVersionId on session created via createSession', () => {
      const mgr = new SessionManager(testConfig);
      const session = mgr.createSession('068XXXXXXXXXXXX', stubSfAuth);
      assert.equal(session.contentVersionId, '068XXXXXXXXXXXX');
      mgr.destroyAll();
    });

    it('should store null contentVersionId on session created via createSessionFromFile', async () => {
      const mgr = new SessionManager(testConfig);
      const session = await mgr.createSessionFromFile(csvPath);
      assert.equal(session.contentVersionId, null);
      await mgr.destroyAll();
    });
  });

  describe('onSessionComplete hook', () => {
    it('should accept onSessionComplete option without error', async () => {
      const mgr = new SessionManager(testConfig, { onSessionComplete: () => {} });
      const session = await mgr.createSessionFromFile(csvPath);

      assert.equal(session.status, 'ready');
      await mgr.destroyAll();
    });

    it('should work normally when onSessionComplete is not provided', async () => {
      const mgr = new SessionManager(testConfig);
      const session = await mgr.createSessionFromFile(csvPath);

      assert.equal(session.status, 'ready');
      await mgr.destroyAll();
    });
  });

  describe('cross-org session isolation', () => {
    it('should isolate sessions by orgId via getSessionForOrg', async () => {
      const mgr = new SessionManager(testConfig);
      const session = await mgr.createSessionFromFile(csvPath);

      // Sessions created via createSessionFromFile have orgId=null, accessible to all
      assert.ok(mgr.getSessionForOrg(session.csvQueryId, 'org_any'));

      await mgr.destroyAll();
    });

    it('should deny access to sessions from a different org', () => {
      const mgr = new SessionManager(testConfig);
      const session = mgr.createSession('068XXXXXXXXXXXX', stubSfAuth, 'org_alpha');

      assert.ok(mgr.getSessionForOrg(session.csvQueryId, 'org_alpha'));
      assert.equal(mgr.getSessionForOrg(session.csvQueryId, 'org_beta'), null);

      mgr.destroyAll();
    });

    it('should deny queryRows from a different org', async () => {
      const mgr = new SessionManager(testConfig);
      const session = await mgr.createSessionFromFile(csvPath);
      // Manually tag with an org after creation for testing
      session.orgId = 'org_alpha';

      await assert.rejects(
        () => mgr.queryRows(session.csvQueryId, 0, 10, 'org_beta'),
        (err) => {
          assert.equal(err.code, 'SESSION_NOT_FOUND');
          return true;
        },
      );

      // Same org should succeed
      const result = await mgr.queryRows(session.csvQueryId, 0, 10, 'org_alpha');
      assert.equal(result.count, 5);

      await mgr.destroyAll();
    });
  });
});

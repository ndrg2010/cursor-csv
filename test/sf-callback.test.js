import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SfCallbackService } from '../src/services/sf-callback.js';

function makeSfAuth({ token = 'mock-token', instanceUrl = 'https://test.my.salesforce.com' } = {}) {
  return {
    getAccessToken: mock.fn(async () => token),
    get instanceUrl() { return instanceUrl; },
    clearToken: mock.fn(),
  };
}

function makeSession(overrides = {}) {
  return {
    csvQueryId: 'cq_abc123def456abc123def456abc123de',
    contentVersionId: '068TESTXXXXXXXX',
    cursorBatchJobId: 'a1fPV000008hHgxYAE',
    orgId: 'org_test01',
    status: 'ready',
    rowCount: 42,
    headers: ['Id', 'Name'],
    columnTypes: ['VARCHAR', 'VARCHAR'],
    error: null,
    ...overrides,
  };
}

const silentLog = {
  info: mock.fn(),
  warn: mock.fn(),
  error: mock.fn(),
  debug: mock.fn(),
};

describe('SfCallbackService', () => {
  const apiVersion = '62.0';
  const platformEventName = 'CursorBatch_Coordinator__e';

  it('should publish coordinator PE with correct payload on ready', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ id: '0000000000', success: true }),
    }));

    try {
      const service = new SfCallbackService({ apiVersion, platformEventName, log: silentLog });
      const sfAuth = makeSfAuth();
      const session = makeSession();

      await service.publish(sfAuth, session);

      const calls = globalThis.fetch.mock.calls;
      assert.equal(calls.length, 1);

      const [url, opts] = calls[0].arguments;
      assert.equal(url, `https://test.my.salesforce.com/services/data/v62.0/sobjects/${platformEventName}/`);
      assert.equal(opts.method, 'POST');
      assert.equal(opts.headers.Authorization, 'Bearer mock-token');
      assert.equal(opts.headers['Content-Type'], 'application/json');

      const body = JSON.parse(opts.body);
      assert.equal(body.Job_Record_Id__c, session.cursorBatchJobId);
      assert.equal(body.Coordinator_Class__c, 'CSV_Ready');
      assert.equal(body.Job_Name__c, session.csvQueryId);
      assert.equal(Object.keys(body).length, 3, 'Payload should only contain three fields');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should publish coordinator PE on error status with same payload shape', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ id: '0000000000', success: true }),
    }));

    try {
      const service = new SfCallbackService({ apiVersion, platformEventName, log: silentLog });
      const sfAuth = makeSfAuth();
      const session = makeSession({
        status: 'error',
        rowCount: 0,
        error: { code: 'INGEST_FAILED', message: 'CSV parse error' },
      });

      await service.publish(sfAuth, session);

      const body = JSON.parse(globalThis.fetch.mock.calls[0].arguments[1].body);
      assert.equal(body.Job_Record_Id__c, session.cursorBatchJobId);
      assert.equal(body.Coordinator_Class__c, 'CSV_Ready');
      assert.equal(body.Job_Name__c, session.csvQueryId);
      assert.equal(Object.keys(body).length, 3, 'Payload should only contain three fields');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should retry once on 500 response then succeed', async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = mock.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 500, text: async () => 'Internal Server Error' };
      }
      return { ok: true, status: 201, json: async () => ({ success: true }) };
    });

    try {
      const service = new SfCallbackService({ apiVersion, platformEventName, log: silentLog });
      const sfAuth = makeSfAuth();
      const session = makeSession();

      await service.publish(sfAuth, session);

      assert.equal(globalThis.fetch.mock.calls.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should cache org on 404 and skip subsequent publishes', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    }));

    try {
      const service = new SfCallbackService({ apiVersion, platformEventName, log: silentLog });
      const sfAuth = makeSfAuth();
      const session = makeSession({ orgId: 'org_denied01' });

      await service.publish(sfAuth, session);
      assert.equal(globalThis.fetch.mock.calls.length, 1, 'First publish should call fetch');

      await service.publish(sfAuth, session);
      assert.equal(globalThis.fetch.mock.calls.length, 1, 'Second publish should be skipped (org denied)');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should cache org on 404 during retry', async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = mock.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 500, text: async () => 'Server Error' };
      }
      return { ok: false, status: 404, text: async () => 'Not Found' };
    });

    try {
      const service = new SfCallbackService({ apiVersion, platformEventName, log: silentLog });
      const sfAuth = makeSfAuth();
      const session = makeSession({ orgId: 'org_denied02' });

      await service.publish(sfAuth, session);
      assert.equal(globalThis.fetch.mock.calls.length, 2);

      await service.publish(sfAuth, session);
      assert.equal(globalThis.fetch.mock.calls.length, 2, 'Subsequent publish skipped');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should not throw on any failure', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    }));

    try {
      const service = new SfCallbackService({ apiVersion, platformEventName, log: silentLog });
      const sfAuth = makeSfAuth();
      const session = makeSession({ orgId: null });

      await assert.doesNotReject(() => service.publish(sfAuth, session));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should not throw when fetch itself throws', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => {
      throw new Error('Network error');
    });

    try {
      const service = new SfCallbackService({ apiVersion, platformEventName, log: silentLog });
      const sfAuth = makeSfAuth();
      const session = makeSession({ orgId: null });

      await assert.doesNotReject(() => service.publish(sfAuth, session));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should clear a denied org so subsequent publishes attempt again', async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = mock.fn(async () => {
      callCount++;
      if (callCount <= 1) {
        return { ok: false, status: 404, text: async () => 'Not Found' };
      }
      return { ok: true, status: 201, json: async () => ({ success: true }) };
    });

    try {
      const service = new SfCallbackService({ apiVersion, platformEventName, log: silentLog });
      const sfAuth = makeSfAuth();
      const session = makeSession({ orgId: 'org_cleared01' });

      await service.publish(sfAuth, session);
      assert.equal(globalThis.fetch.mock.calls.length, 1);

      service.clearDeniedOrg('org_cleared01');

      await service.publish(sfAuth, session);
      assert.equal(globalThis.fetch.mock.calls.length, 2, 'Should attempt again after clearDeniedOrg');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should skip callback when orgId is null and org is not denied', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ success: true }),
    }));

    try {
      const service = new SfCallbackService({ apiVersion, platformEventName, log: silentLog });
      const sfAuth = makeSfAuth();
      const session = makeSession({ orgId: null });

      await service.publish(sfAuth, session);
      assert.equal(globalThis.fetch.mock.calls.length, 1, 'Should still publish for null orgId');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

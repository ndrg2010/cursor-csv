import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SfAuthManager } from '../src/services/sf-auth.js';

describe('SfAuthManager', () => {
  const sfConfig = {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    loginUrl: 'https://test.my.salesforce.com',
  };

  it('should request a token on first call', async () => {
    const auth = new SfAuthManager(sfConfig);

    const mockResponse = {
      ok: true,
      json: async () => ({
        access_token: 'mock-token-123',
        instance_url: 'https://test.my.salesforce.com',
        expires_in: 7200,
      }),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => mockResponse);

    try {
      const token = await auth.getAccessToken();
      assert.equal(token, 'mock-token-123');
      assert.equal(auth.instanceUrl, 'https://test.my.salesforce.com');

      const calls = globalThis.fetch.mock.calls;
      assert.equal(calls.length, 1);
      assert.ok(calls[0].arguments[0].includes('/services/oauth2/token'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should return cached token on subsequent calls', async () => {
    const auth = new SfAuthManager(sfConfig);

    const mockResponse = {
      ok: true,
      json: async () => ({
        access_token: 'cached-token',
        instance_url: 'https://test.my.salesforce.com',
        expires_in: 7200,
      }),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => mockResponse);

    try {
      await auth.getAccessToken();
      await auth.getAccessToken();
      await auth.getAccessToken();

      assert.equal(globalThis.fetch.mock.calls.length, 1, 'Should only fetch once');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should throw on auth failure', async () => {
    const auth = new SfAuthManager(sfConfig);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
    }));

    try {
      await assert.rejects(
        () => auth.getAccessToken(),
        (err) => {
          assert.equal(err.code, 'SF_AUTH_FAILED');
          assert.equal(err.statusCode, 502);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should re-authenticate after clearToken', async () => {
    const auth = new SfAuthManager(sfConfig);

    let callCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: `token-${++callCount}`,
        instance_url: 'https://test.my.salesforce.com',
        expires_in: 7200,
      }),
    }));

    try {
      const t1 = await auth.getAccessToken();
      assert.equal(t1, 'token-1');

      auth.clearToken();

      const t2 = await auth.getAccessToken();
      assert.equal(t2, 'token-2');
      assert.equal(globalThis.fetch.mock.calls.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

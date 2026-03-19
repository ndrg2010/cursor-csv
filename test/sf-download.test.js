import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ReadableStream } from 'node:stream/web';
import { downloadContentVersion } from '../src/services/sf-download.js';

const TMP_DIR = join(process.cwd(), 'tmp');

function textEncoder() {
  return new TextEncoder();
}

function makeSfAuth({ token = 'mock-token', instanceUrl = 'https://test.my.salesforce.com' } = {}) {
  return {
    getAccessToken: mock.fn(async () => token),
    get instanceUrl() { return instanceUrl; },
    clearToken: mock.fn(),
  };
}

function csvStream(text) {
  const encoded = textEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
}

function mockFetchOk(body, headers = {}) {
  return mock.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/octet-stream', ...headers }),
    body: csvStream(body),
  }));
}

describe('downloadContentVersion', () => {
  let destPath;
  const apiVersion = '62.0';

  afterEach(async () => {
    if (destPath) await unlink(destPath).catch(() => {});
  });

  it('should download CSV to dest path', async () => {
    const originalFetch = globalThis.fetch;
    const csvText = 'Id,Name\n1,Acme\n2,Beta\n';
    globalThis.fetch = mockFetchOk(csvText);

    try {
      await mkdir(TMP_DIR, { recursive: true });
      destPath = join(TMP_DIR, 'dl-test-basic.csv');
      const sfAuth = makeSfAuth();

      const result = await downloadContentVersion(sfAuth, '068TESTXXXXXXXX', destPath, apiVersion);
      assert.equal(result, destPath);

      const written = await readFile(destPath, 'utf8');
      assert.equal(written, csvText);

      const fetchCall = globalThis.fetch.mock.calls[0];
      assert.ok(fetchCall.arguments[0].includes('/ContentVersion/068TESTXXXXXXXX/VersionData'));
      assert.equal(fetchCall.arguments[1].headers.Authorization, 'Bearer mock-token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should retry on 401 and succeed on second attempt', async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = mock.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 401, text: async () => 'Unauthorized', headers: new Headers() };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        body: csvStream('Id\n1\n'),
      };
    });

    try {
      await mkdir(TMP_DIR, { recursive: true });
      destPath = join(TMP_DIR, 'dl-test-retry.csv');
      const sfAuth = makeSfAuth();

      await downloadContentVersion(sfAuth, '068TESTXXXXXXXX', destPath, apiVersion);

      assert.equal(globalThis.fetch.mock.calls.length, 2);
      assert.equal(sfAuth.clearToken.mock.calls.length, 1);

      const written = await readFile(destPath, 'utf8');
      assert.equal(written, 'Id\n1\n');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should throw SF_DOWNLOAD_FAILED on non-401 error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
      headers: new Headers(),
    }));

    try {
      await mkdir(TMP_DIR, { recursive: true });
      destPath = join(TMP_DIR, 'dl-test-404.csv');
      const sfAuth = makeSfAuth();

      await assert.rejects(
        () => downloadContentVersion(sfAuth, '068TESTXXXXXXXX', destPath, apiVersion),
        (err) => {
          assert.equal(err.code, 'SF_DOWNLOAD_FAILED');
          assert.equal(err.statusCode, 502);
          assert.equal(err.details.httpStatus, 404);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should throw CSV_TOO_LARGE when file exceeds maxCsvSizeBytes', async () => {
    const originalFetch = globalThis.fetch;
    const bigBody = 'x'.repeat(200);
    globalThis.fetch = mockFetchOk(bigBody);

    try {
      await mkdir(TMP_DIR, { recursive: true });
      destPath = join(TMP_DIR, 'dl-test-size.csv');
      const sfAuth = makeSfAuth();

      await assert.rejects(
        () => downloadContentVersion(sfAuth, '068TESTXXXXXXXX', destPath, apiVersion, {
          maxCsvSizeBytes: 50,
        }),
        (err) => {
          assert.equal(err.code, 'CSV_TOO_LARGE');
          assert.equal(err.statusCode, 413);
          return true;
        },
      );

      const exists = await stat(destPath).then(() => true).catch(() => false);
      assert.equal(exists, false, 'Temp file should be cleaned up after size limit error');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should throw UNEXPECTED_CONTENT_TYPE for non-CSV responses', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/pdf' }),
      body: csvStream('not-csv'),
    }));

    try {
      await mkdir(TMP_DIR, { recursive: true });
      destPath = join(TMP_DIR, 'dl-test-ct.csv');
      const sfAuth = makeSfAuth();

      await assert.rejects(
        () => downloadContentVersion(sfAuth, '068TESTXXXXXXXX', destPath, apiVersion),
        (err) => {
          assert.equal(err.code, 'UNEXPECTED_CONTENT_TYPE');
          assert.equal(err.statusCode, 422);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should throw SF_EMPTY_BODY when response body is null', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/octet-stream' }),
      body: null,
    }));

    try {
      await mkdir(TMP_DIR, { recursive: true });
      destPath = join(TMP_DIR, 'dl-test-null.csv');
      const sfAuth = makeSfAuth();

      await assert.rejects(
        () => downloadContentVersion(sfAuth, '068TESTXXXXXXXX', destPath, apiVersion),
        (err) => {
          assert.equal(err.code, 'SF_EMPTY_BODY');
          assert.equal(err.statusCode, 502);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should accept text/csv content type', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchOk('Id\n1\n', { 'content-type': 'text/csv; charset=utf-8' });

    try {
      await mkdir(TMP_DIR, { recursive: true });
      destPath = join(TMP_DIR, 'dl-test-textcsv.csv');
      const sfAuth = makeSfAuth();

      const result = await downloadContentVersion(sfAuth, '068TESTXXXXXXXX', destPath, apiVersion);
      assert.equal(result, destPath);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should respect external abort signal', async () => {
    const originalFetch = globalThis.fetch;
    const ac = new AbortController();
    ac.abort();

    globalThis.fetch = mock.fn(async (url, opts) => {
      opts.signal.throwIfAborted();
      return { ok: true, status: 200, headers: new Headers(), body: csvStream('Id\n1\n') };
    });

    try {
      await mkdir(TMP_DIR, { recursive: true });
      destPath = join(TMP_DIR, 'dl-test-abort.csv');
      const sfAuth = makeSfAuth();

      await assert.rejects(
        () => downloadContentVersion(sfAuth, '068TESTXXXXXXXX', destPath, apiVersion, { signal: ac.signal }),
        (err) => {
          assert.equal(err.name, 'AbortError');
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should throw SF_DOWNLOAD_FAILED after exhausting retries on 401', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'Session expired',
      headers: new Headers(),
    }));

    try {
      await mkdir(TMP_DIR, { recursive: true });
      destPath = join(TMP_DIR, 'dl-test-401-exhaust.csv');
      const sfAuth = makeSfAuth();

      await assert.rejects(
        () => downloadContentVersion(sfAuth, '068TESTXXXXXXXX', destPath, apiVersion),
        (err) => {
          assert.equal(err.code, 'SF_DOWNLOAD_FAILED');
          assert.equal(err.details.httpStatus, 401);
          return true;
        },
      );
      assert.equal(globalThis.fetch.mock.calls.length, 2);
      assert.equal(sfAuth.clearToken.mock.calls.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

function createSizeLimitTransform(maxBytes) {
  let bytesWritten = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      bytesWritten += chunk.length;
      if (bytesWritten > maxBytes) {
        callback(Object.assign(
          new Error(`CSV exceeds maximum size of ${Math.round(maxBytes / 1024 / 1024)}MB`),
          { code: 'CSV_TOO_LARGE', statusCode: 413 },
        ));
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * Downloads a ContentVersion's VersionData from Salesforce REST API
 * to a local temp file via streaming (no full-file buffering in memory).
 */
export async function downloadContentVersion(sfAuth, contentVersionId, destPath, apiVersion, options = {}) {
  const { fetchTimeoutMs = 30_000, maxCsvSizeBytes, signal } = options;
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const token = await sfAuth.getAccessToken();
    const instanceUrl = sfAuth.instanceUrl;
    const url = `${instanceUrl}/services/data/v${apiVersion}/sobjects/ContentVersion/${contentVersionId}/VersionData`;

    const timeoutSignal = AbortSignal.timeout(fetchTimeoutMs);
    const fetchSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: fetchSignal,
    });

    if (!response.ok) {
      if (response.status === 401 && attempt < maxAttempts) {
        await response.body?.cancel().catch(() => {});
        sfAuth.clearToken();
        continue;
      }
      const text = await response.text().catch(() => '');
      throw Object.assign(
        new Error(`SF download failed: ${response.status}`),
        { code: 'SF_DOWNLOAD_FAILED', statusCode: 502, details: { contentVersionId, httpStatus: response.status } },
      );
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.includes('text/csv') && !contentType.includes('application/octet-stream')) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(
        new Error(`Expected CSV but received Content-Type: ${contentType}`),
        { code: 'UNEXPECTED_CONTENT_TYPE', statusCode: 422, details: { contentVersionId, contentType } },
      );
    }

    if (!response.body) {
      throw Object.assign(
        new Error('SF returned empty response body'),
        { code: 'SF_EMPTY_BODY', statusCode: 502, details: { contentVersionId } },
      );
    }

    const nodeStream = Readable.fromWeb(response.body);
    const fileStream = createWriteStream(destPath);
    const streams = [nodeStream];

    if (maxCsvSizeBytes) {
      streams.push(createSizeLimitTransform(maxCsvSizeBytes));
    }
    streams.push(fileStream);

    const pipelineOpts = signal ? { signal } : undefined;

    try {
      await pipeline(...streams, ...(pipelineOpts ? [pipelineOpts] : []));
    } catch (err) {
      await unlink(destPath).catch(() => {});
      if (err.code === 'CSV_TOO_LARGE' || err.name === 'AbortError') throw err;
      throw Object.assign(
        new Error(`Failed to write CSV to disk: ${err.message}`),
        { code: 'DOWNLOAD_WRITE_FAILED', statusCode: 500 },
      );
    }

    return destPath;
  }
}

import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { unlink } from 'node:fs/promises';
import { DuckDBInstance } from '@duckdb/node-api';
import { downloadContentVersion } from './sf-download.js';

const ERROR_SESSION_TTL_MS = 60_000;

/**
 * @typedef {'preparing' | 'ready' | 'error'} SessionStatus
 *
 * @typedef {Object} Session
 * @property {string} csvQueryId
 * @property {string} contentVersionId
 * @property {SessionStatus} status
 * @property {number} rowCount
 * @property {string[]} headers
 * @property {string[]} columnTypes
 * @property {number} createdAt
 * @property {number} lastAccessedAt
 * @property {number} expiresAt
 * @property {DuckDBInstance} [db]
 * @property {import('@duckdb/node-api').DuckDBConnection} [conn]
 * @property {AbortController} [abortController]
 * @property {{code: string, message: string}} [error]
 * @property {number} activeQueries
 */

export class SessionManager {
  /** @type {Map<string, Session>} */
  #sessions = new Map();
  #config;
  #tmpDir;
  #cleanupTimer = null;
  #onError;
  #onSessionComplete;
  #log;

  /**
   * @param {object} config
   * @param {{ onError?: (err: Error, session: Session) => void, onSessionComplete?: (session: Session, sfAuth: import('./sf-auth.js').SfAuthManager) => void, log?: object }} [options]
   */
  constructor(config, options = {}) {
    this.#config = config;
    this.#tmpDir = resolve(config.tmpDir || './tmp');
    this.#onError = options.onError || null;
    this.#onSessionComplete = options.onSessionComplete || null;
    this.#log = options.log || console;
  }

  get sessionCount() {
    return this.#sessions.size;
  }

  getSession(csvQueryId) {
    return this.#sessions.get(csvQueryId) || null;
  }

  /**
   * Get a session only if it belongs to the given org.
   * Returns null if the session doesn't exist or belongs to a different org.
   */
  getSessionForOrg(csvQueryId, orgId) {
    const session = this.#sessions.get(csvQueryId);
    if (!session) return null;
    if (session.orgId && orgId && session.orgId !== orgId) return null;
    return session;
  }

  /**
   * Touch the session to reset its TTL (sliding window).
   */
  touch(csvQueryId) {
    const session = this.#sessions.get(csvQueryId);
    if (!session) return null;
    const now = Date.now();
    session.lastAccessedAt = now;
    if (session.status !== 'error') {
      session.expiresAt = now + this.#config.csv.ttlSeconds * 1000;
    }
    return session;
  }

  /**
   * Find an existing session for the same contentVersionId + org (dedup).
   */
  #findExistingSession(contentVersionId, orgId) {
    for (const session of this.#sessions.values()) {
      if (
        session.contentVersionId === contentVersionId &&
        session.orgId === orgId &&
        session.status !== 'error'
      ) {
        return session;
      }
    }
    return null;
  }

  /**
   * Create a new session and begin background CSV ingestion.
   * Returns immediately with csvQueryId and status "preparing".
   * Deduplicates by contentVersionId+orgId — returns existing session if one is active.
   * @param {string} contentVersionId
   * @param {import('./sf-auth.js').SfAuthManager} sfAuth
   * @param {string} [orgId]
   */
  createSession(contentVersionId, sfAuth, orgId) {
    const existing = this.#findExistingSession(contentVersionId, orgId);
    if (existing) {
      this.touch(existing.csvQueryId);
      return existing;
    }

    if (this.#sessions.size >= this.#config.csv.maxConcurrentSessions) {
      throw Object.assign(
        new Error(`Max concurrent sessions (${this.#config.csv.maxConcurrentSessions}) reached`),
        { code: 'MAX_SESSIONS_REACHED', statusCode: 429 },
      );
    }

    const csvQueryId = `cq_${randomUUID().replace(/-/g, '')}`;
    const now = Date.now();

    /** @type {Session} */
    const session = {
      csvQueryId,
      contentVersionId,
      orgId: orgId || null,
      status: 'preparing',
      rowCount: 0,
      headers: [],
      columnTypes: [],
      createdAt: now,
      lastAccessedAt: now,
      expiresAt: now + this.#config.csv.ttlSeconds * 1000,
      db: null,
      conn: null,
      abortController: new AbortController(),
      error: null,
      activeQueries: 0,
    };

    this.#sessions.set(csvQueryId, session);

    this.#ingestInBackground(session, contentVersionId, sfAuth).catch((err) => {
      if (err.name === 'AbortError') return;
      if (this.#onError) this.#onError(err, session);
    });

    return session;
  }

  /**
   * Ingest directly from a local file path (for testing without Salesforce).
   */
  async createSessionFromFile(filePath) {
    if (this.#sessions.size >= this.#config.csv.maxConcurrentSessions) {
      throw Object.assign(
        new Error(`Max concurrent sessions (${this.#config.csv.maxConcurrentSessions}) reached`),
        { code: 'MAX_SESSIONS_REACHED', statusCode: 429 },
      );
    }

    const csvQueryId = `cq_${randomUUID().replace(/-/g, '')}`;
    const now = Date.now();

    const session = {
      csvQueryId,
      contentVersionId: null,
      status: 'preparing',
      rowCount: 0,
      headers: [],
      columnTypes: [],
      createdAt: now,
      lastAccessedAt: now,
      expiresAt: now + this.#config.csv.ttlSeconds * 1000,
      db: null,
      conn: null,
      abortController: new AbortController(),
      error: null,
      activeQueries: 0,
    };

    this.#sessions.set(csvQueryId, session);

    try {
      await this.#importCsv(session, filePath);
    } catch (err) {
      this.#sessions.delete(csvQueryId);
      throw err;
    }

    return session;
  }

  async #ingestInBackground(session, contentVersionId, sfAuth) {
    const tempFile = join(this.#tmpDir, `${session.csvQueryId}.csv`);
    const { signal } = session.abortController;

    try {
      this.touch(session.csvQueryId);
      await downloadContentVersion(
        sfAuth,
        contentVersionId,
        tempFile,
        this.#config.sf.apiVersion,
        {
          fetchTimeoutMs: this.#config.sf.fetchTimeoutMs,
          maxCsvSizeBytes: this.#config.csv.maxCsvSizeBytes,
          signal,
        },
      );

      if (signal.aborted) throw signal.reason;

      this.touch(session.csvQueryId);
      await this.#importCsv(session, tempFile);

      this.#fireComplete(session, sfAuth);
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      session.status = 'error';
      session.error = {
        code: err.code || 'INGEST_FAILED',
        message: err.message,
      };
      session.expiresAt = Date.now() + ERROR_SESSION_TTL_MS;

      this.#fireComplete(session, sfAuth);
      throw err;
    } finally {
      await unlink(tempFile).catch((e) => {
        this.#log.debug?.({ err: e, path: tempFile }, 'Failed to remove temp file');
      });
    }
  }

  async #importCsv(session, filePath) {
    const resolvedPath = resolve(filePath);
    if (!resolvedPath.startsWith(this.#tmpDir + '/')) {
      throw Object.assign(
        new Error('File path must be under the configured tmp directory'),
        { code: 'INVALID_FILE_PATH', statusCode: 400 },
      );
    }

    let instance;
    let conn;
    try {
      instance = await DuckDBInstance.create(':memory:');
      conn = await instance.connect();

      if (session.abortController?.signal.aborted) {
        throw session.abortController.signal.reason;
      }

      const safePath = resolvedPath.replace(/'/g, "''");
      await conn.run(`CREATE TABLE csv_data AS SELECT * FROM read_csv_auto('${safePath}', all_varchar=true)`);

      const countResult = await conn.runAndReadAll('SELECT count(*)::INTEGER AS cnt FROM csv_data');
      session.rowCount = countResult.getRows()[0][0];

      const metaResult = await conn.runAndReadAll('SELECT * FROM csv_data LIMIT 0');
      session.headers = metaResult.columnNames();
      session.columnTypes = metaResult.columnTypes().map(t => t.toString());
    } catch (err) {
      if (conn) await conn.close().catch(() => {});
      if (instance) await instance.close().catch(() => {});
      throw err;
    }

    if (session.abortController?.signal.aborted) {
      await conn.close().catch(() => {});
      await instance.close().catch(() => {});
      throw session.abortController.signal.reason;
    }

    session.db = instance;
    session.conn = conn;
    session.status = 'ready';
  }

  #fireComplete(session, sfAuth) {
    if (this.#onSessionComplete) {
      Promise.resolve(this.#onSessionComplete(session, sfAuth)).catch(() => {});
    }
  }

  async queryRows(csvQueryId, start, count, orgId) {
    const session = this.touch(csvQueryId);
    if (!session || (session.orgId && orgId && session.orgId !== orgId)) {
      throw Object.assign(
        new Error('Session not found'),
        { code: 'SESSION_NOT_FOUND', statusCode: 404 },
      );
    }
    if (session.status !== 'ready') {
      throw Object.assign(
        new Error(`Session is not ready (status: ${session.status})`),
        { code: 'SESSION_NOT_READY', statusCode: 409 },
      );
    }

    const safeStart = Number.isInteger(start) && start >= 0 ? start : 0;
    const safeCount = Math.min(
      Number.isInteger(count) && count > 0 ? count : 1,
      this.#config.csv.maxRowFetch,
    );

    session.activeQueries++;
    try {
      const result = await session.conn.runAndReadAll(
        `SELECT * FROM csv_data LIMIT ${safeCount} OFFSET ${safeStart}`,
      );

      const rows = result.getRowObjectsJson();

      return {
        csvQueryId,
        start: safeStart,
        count: rows.length,
        rows,
        hasMore: safeStart + rows.length < session.rowCount,
        totalRows: session.rowCount,
      };
    } finally {
      session.activeQueries--;
    }
  }

  async destroySession(csvQueryId) {
    const session = this.#sessions.get(csvQueryId);
    if (!session) return false;

    this.#sessions.delete(csvQueryId);

    if (session.abortController) session.abortController.abort();

    if (session.activeQueries > 0) {
      const maxWait = 5_000;
      const start = Date.now();
      while (session.activeQueries > 0 && Date.now() - start < maxWait) {
        await new Promise(r => setTimeout(r, 50));
      }
    }

    try {
      if (session.conn) await session.conn.close();
    } catch { /* already closed */ }
    try {
      if (session.db) await session.db.close();
    } catch { /* already closed */ }
    return true;
  }

  async destroyAll() {
    const ids = [...this.#sessions.keys()];
    const results = await Promise.allSettled(ids.map(id => this.destroySession(id)));
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        this.#log.warn?.({ err: results[i].reason, csvQueryId: ids[i] }, 'Failed to destroy session during cleanup');
      }
    }
  }

  async sweepExpired() {
    const now = Date.now();
    const expired = [];
    for (const [id, session] of this.#sessions) {
      if (now > session.expiresAt) {
        expired.push(id);
      }
    }
    for (const id of expired) {
      await this.destroySession(id);
    }
    return expired.length;
  }

  startCleanupInterval() {
    if (this.#cleanupTimer) return;
    this.#cleanupTimer = setInterval(() => {
      this.sweepExpired().catch(() => {});
    }, 60_000);
    this.#cleanupTimer.unref();
  }

  stopCleanupInterval() {
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }
  }
}

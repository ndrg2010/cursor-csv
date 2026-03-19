import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SfAuthManager } from './sf-auth.js';

function hashKey(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * @typedef {Object} OrgRecord
 * @property {string} orgId
 * @property {string} label
 * @property {string} loginUrl
 * @property {string} apiKeyHash
 * @property {string} registeredAt
 * @property {string|null} lastUsedAt
 */

export class OrgRegistry {
  /** @type {Map<string, OrgRecord>} orgId -> record */
  #orgs = new Map();
  /** @type {Map<string, string>} apiKeyHash -> orgId (reverse index) */
  #keyIndex = new Map();
  /** @type {Map<string, SfAuthManager>} orgId -> auth manager */
  #authManagers = new Map();

  #ecaClientId;
  #ecaClientSecret;
  #sfApiVersion;
  #sfFetchTimeoutMs;
  #filePath;
  #log;
  #writeLock = null;
  #lastUsedDirty = false;
  #flushTimer = null;

  /**
   * @param {object} options
   * @param {string} options.ecaClientId
   * @param {string} options.ecaClientSecret
   * @param {string} [options.sfApiVersion]
   * @param {number} [options.sfFetchTimeoutMs]
   * @param {string} options.dataDir
   * @param {object} [options.log]
   */
  constructor({ ecaClientId, ecaClientSecret, sfApiVersion = '62.0', sfFetchTimeoutMs = 30_000, dataDir, log }) {
    this.#ecaClientId = ecaClientId;
    this.#ecaClientSecret = ecaClientSecret;
    this.#sfApiVersion = sfApiVersion;
    this.#sfFetchTimeoutMs = sfFetchTimeoutMs;
    this.#filePath = join(dataDir, 'orgs.json');
    this.#log = log || console;
  }

  get size() {
    return this.#orgs.size;
  }

  async load() {
    try {
      const raw = await readFile(this.#filePath, 'utf-8');
      const data = JSON.parse(raw);
      const orgs = data.orgs || {};

      this.#orgs.clear();
      this.#keyIndex.clear();
      this.#authManagers.clear();

      for (const [orgId, record] of Object.entries(orgs)) {
        if (!record.orgId || !record.loginUrl) continue;
        // Support both legacy (apiKey) and new (apiKeyHash) formats
        const keyHash = record.apiKeyHash || (record.apiKey ? hashKey(record.apiKey) : null);
        if (!keyHash) continue;
        const normalized = { ...record, apiKeyHash: keyHash };
        delete normalized.apiKey;
        this.#orgs.set(orgId, normalized);
        this.#keyIndex.set(keyHash, orgId);
      }

      this.#log.info?.({ count: this.#orgs.size }, 'Loaded org registry');
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.#log.info?.('No existing org registry found, starting empty');
        return;
      }
      throw err;
    }
  }

  async #save() {
    const orgs = Object.fromEntries(this.#orgs);
    const dir = dirname(this.#filePath);
    await mkdir(dir, { recursive: true });
    const tmpPath = join(dir, `.orgs.${Date.now()}.tmp`);
    try {
      await writeFile(tmpPath, JSON.stringify({ orgs }, null, 2), { encoding: 'utf-8', mode: 0o600 });
      await rename(tmpPath, this.#filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  async #withLock(fn) {
    while (this.#writeLock) await this.#writeLock;
    let resolve;
    this.#writeLock = new Promise(r => { resolve = r; });
    try {
      return await fn();
    } finally {
      this.#writeLock = null;
      resolve();
    }
  }

  #generateApiKey() {
    return `csvmw_${randomBytes(24).toString('hex')}`;
  }

  #generateOrgId() {
    return `org_${randomBytes(4).toString('hex')}`;
  }

  #createAuthManager(loginUrl) {
    return new SfAuthManager({
      clientId: this.#ecaClientId,
      clientSecret: this.#ecaClientSecret,
      loginUrl,
      fetchTimeoutMs: this.#sfFetchTimeoutMs,
    });
  }

  /**
   * Register a new org. Validates credentials by attempting authentication.
   * @param {string} loginUrl
   * @param {string} [label]
   * @returns {Promise<{ orgId: string, apiKey: string, label: string }>}
   */
  async register(loginUrl, label) {
    return this.#withLock(async () => {
      const normalizedUrl = loginUrl.replace(/\/+$/, '');

      for (const record of this.#orgs.values()) {
        if (record.loginUrl === normalizedUrl) {
          throw Object.assign(
            new Error(`Org with login URL "${normalizedUrl}" is already registered as "${record.orgId}"`),
            { code: 'ORG_ALREADY_REGISTERED', statusCode: 409 },
          );
        }
      }

      const testAuth = this.#createAuthManager(normalizedUrl);
      await testAuth.getAccessToken();

      const orgId = this.#generateOrgId();
      const rawKey = this.#generateApiKey();
      const keyHash = hashKey(rawKey);

      /** @type {OrgRecord} */
      const record = {
        orgId,
        label: label || normalizedUrl,
        loginUrl: normalizedUrl,
        apiKeyHash: keyHash,
        registeredAt: new Date().toISOString(),
        lastUsedAt: null,
      };

      this.#orgs.set(orgId, record);
      this.#keyIndex.set(keyHash, orgId);
      this.#authManagers.set(orgId, testAuth);
      try {
        await this.#save();
      } catch (err) {
        this.#orgs.delete(orgId);
        this.#keyIndex.delete(keyHash);
        this.#authManagers.delete(orgId);
        throw err;
      }

      this.#log.info?.({ orgId, label: record.label }, 'Org registered');
      return { orgId, apiKey: rawKey, label: record.label };
    });
  }

  /**
   * List all registered orgs (no secrets exposed).
   * @returns {Array<{ orgId: string, label: string, loginUrl: string, registeredAt: string, lastUsedAt: string|null }>}
   */
  list() {
    return [...this.#orgs.values()].map(({ orgId, label, loginUrl, registeredAt, lastUsedAt }) => ({
      orgId, label, loginUrl, registeredAt, lastUsedAt,
    }));
  }

  /**
   * Remove a registered org.
   * @param {string} orgId
   * @returns {Promise<boolean>}
   */
  async remove(orgId) {
    return this.#withLock(async () => {
      const record = this.#orgs.get(orgId);
      if (!record) return false;

      const authManager = this.#authManagers.get(orgId);
      this.#keyIndex.delete(record.apiKeyHash);
      this.#orgs.delete(orgId);
      this.#authManagers.delete(orgId);
      try {
        await this.#save();
      } catch (err) {
        this.#orgs.set(orgId, record);
        this.#keyIndex.set(record.apiKeyHash, orgId);
        if (authManager) this.#authManagers.set(orgId, authManager);
        throw err;
      }
      this.#log.info?.({ orgId }, 'Org removed');
      return true;
    });
  }

  /**
   * Rotate the API key for an org.
   * @param {string} orgId
   * @returns {Promise<{ apiKey: string } | null>}
   */
  async rotateKey(orgId) {
    return this.#withLock(async () => {
      const record = this.#orgs.get(orgId);
      if (!record) return null;

      const oldHash = record.apiKeyHash;
      this.#keyIndex.delete(oldHash);
      const newRawKey = this.#generateApiKey();
      const newHash = hashKey(newRawKey);
      record.apiKeyHash = newHash;
      this.#keyIndex.set(newHash, orgId);
      try {
        await this.#save();
      } catch (err) {
        this.#keyIndex.delete(newHash);
        record.apiKeyHash = oldHash;
        this.#keyIndex.set(oldHash, orgId);
        throw err;
      }

      this.#log.info?.({ orgId }, 'Org API key rotated');
      return { apiKey: newRawKey };
    });
  }

  /**
   * Look up an org by its API key. Returns the org context including its SfAuthManager.
   * @param {string} apiKey - raw API key
   * @returns {{ orgId: string, label: string, loginUrl: string, sfAuth: SfAuthManager } | null}
   */
  getOrgByApiKey(apiKey) {
    const keyHash = hashKey(apiKey);
    const orgId = this.#keyIndex.get(keyHash);
    if (!orgId) return null;

    const record = this.#orgs.get(orgId);
    if (!record) return null;

    record.lastUsedAt = new Date().toISOString();
    this.#lastUsedDirty = true;

    if (!this.#authManagers.has(orgId)) {
      this.#authManagers.set(orgId, this.#createAuthManager(record.loginUrl));
    }

    return {
      orgId: record.orgId,
      label: record.label,
      loginUrl: record.loginUrl,
      sfAuth: this.#authManagers.get(orgId),
    };
  }

  /**
   * Look up an org by ID (no secrets exposed).
   * @param {string} orgId
   * @returns {{ orgId: string, label: string, loginUrl: string, registeredAt: string, lastUsedAt: string|null } | null}
   */
  getOrgById(orgId) {
    const record = this.#orgs.get(orgId);
    if (!record) return null;
    const { orgId: id, label, loginUrl, registeredAt, lastUsedAt } = record;
    return { orgId: id, label, loginUrl, registeredAt, lastUsedAt };
  }

  async flushLastUsedAt() {
    if (!this.#lastUsedDirty) return;
    return this.#withLock(async () => {
      if (!this.#lastUsedDirty) return;
      this.#lastUsedDirty = false;
      await this.#save();
    });
  }

  startFlushInterval() {
    if (this.#flushTimer) return;
    this.#flushTimer = setInterval(() => {
      this.flushLastUsedAt().catch(() => {});
    }, 5 * 60_000);
    this.#flushTimer.unref();
  }

  stopFlushInterval() {
    if (this.#flushTimer) {
      clearInterval(this.#flushTimer);
      this.#flushTimer = null;
    }
  }
}

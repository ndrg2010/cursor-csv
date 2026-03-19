import { resolve } from 'node:path';

const VALID_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

const logLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
if (!VALID_LOG_LEVELS.includes(logLevel)) {
  throw new Error(`Invalid LOG_LEVEL "${logLevel}". Must be one of: ${VALID_LOG_LEVELS.join(', ')}`);
}

function parseIntEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}="${raw}". Must be a non-negative integer.`);
  }
  return parsed;
}

function parseBoolEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return raw === '1' || raw.toLowerCase() === 'true';
}

const sfApiVersion = process.env.SF_API_VERSION || '62.0';
if (!/^\d+\.\d+$/.test(sfApiVersion)) {
  throw new Error(`Invalid SF_API_VERSION "${sfApiVersion}". Must match pattern "N.N" (e.g. "62.0").`);
}

const config = {
  port: parseIntEnv('PORT', 3000),
  logLevel,
  nodeEnv: process.env.NODE_ENV || 'development',
  adminApiKey: process.env.ADMIN_API_KEY,
  dataDir: resolve(process.env.DATA_DIR || './data'),
  tmpDir: resolve(process.env.TMP_DIR || './tmp'),

  eca: {
    clientId: process.env.ECA_CLIENT_ID,
    clientSecret: process.env.ECA_CLIENT_SECRET,
  },

  sf: {
    apiVersion: sfApiVersion,
    fetchTimeoutMs: parseIntEnv('SF_FETCH_TIMEOUT_MS', 30000),
  },

  csv: {
    ttlSeconds: parseIntEnv('CSV_TTL_SECONDS', 900),
    maxConcurrentSessions: parseIntEnv('MAX_CONCURRENT_SESSIONS', 10),
    maxRowFetch: parseIntEnv('MAX_ROW_FETCH', 2000),
    maxCsvSizeBytes: parseIntEnv('MAX_CSV_SIZE_BYTES', 100 * 1024 * 1024),
  },

  callback: {
    enabled: parseBoolEnv('CALLBACK_ENABLED', true),
    platformEventName: process.env.CALLBACK_PLATFORM_EVENT || 'CursorBatch_Coordinator__e',
  },
};

const required = {
  ECA_CLIENT_ID: config.eca.clientId,
  ECA_CLIENT_SECRET: config.eca.clientSecret,
};

const missing = Object.entries(required)
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

export default config;

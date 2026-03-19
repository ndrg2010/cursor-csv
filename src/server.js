import { randomUUID } from 'node:crypto';
import { mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import config from './config.js';
import authPlugin from './plugins/auth.js';
import csvRoutes from './routes/csv.js';
import orgRoutes from './routes/orgs.js';
import healthRoutes from './routes/health.js';
import { SessionManager } from './services/session-manager.js';
import { OrgRegistry } from './services/org-registry.js';
import { SfCallbackService } from './services/sf-callback.js';

const app = Fastify({
  logger: {
    level: config.logLevel,
  },
  genReqId: () => randomUUID(),
  connectionTimeout: 60_000,
  requestTimeout: 30_000,
});

app.addHook('onSend', (request, reply, payload, done) => {
  reply.header('x-request-id', request.id);
  done(null, payload);
});

const orgRegistry = new OrgRegistry({
  ecaClientId: config.eca.clientId,
  ecaClientSecret: config.eca.clientSecret,
  sfApiVersion: config.sf.apiVersion,
  sfFetchTimeoutMs: config.sf.fetchTimeoutMs,
  dataDir: config.dataDir,
  log: app.log,
});

const callbackService = config.callback.enabled
  ? new SfCallbackService({
      apiVersion: config.sf.apiVersion,
      platformEventName: config.callback.platformEventName,
      log: app.log,
    })
  : null;

const sessionManager = new SessionManager(config, {
  log: app.log,
  onError: (err, session) => {
    app.log.error({ err, csvQueryId: session.csvQueryId, contentVersionId: session.contentVersionId }, 'Background CSV ingest failed');
  },
  onSessionComplete: callbackService
    ? (session, sfAuth) => callbackService.publish(sfAuth, session)
    : null,
});

app.decorate('config', config);
app.decorate('orgRegistry', orgRegistry);
app.decorate('sessionManager', sessionManager);

app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  keyGenerator: (request) => request.ip,
  addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true },
  addHeaders: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'retry-after': true },
});

app.register(authPlugin);
app.register(orgRoutes, { prefix: '/v1/orgs' });
app.register(csvRoutes, { prefix: '/v1/csv' });
app.register(healthRoutes);

app.setErrorHandler((error, request, reply) => {
  const statusCode = error.statusCode || 500;
  request.log.error(error);

  if (error.validation) {
    return reply.status(400).send({
      code: 'VALIDATION_ERROR',
      message: error.message,
    });
  }

  reply.status(statusCode).send({
    code: error.code || 'INTERNAL_ERROR',
    message: statusCode >= 500 ? 'An internal error occurred' : error.message,
  });
});

async function sweepStaleTempFiles(tmpDir) {
  const entries = await readdir(tmpDir).catch(() => []);
  const stale = entries.filter(f => f.startsWith('cq_') && f.endsWith('.csv'));
  await Promise.all(stale.map(f => unlink(join(tmpDir, f)).catch(() => {})));
  if (stale.length > 0) {
    app.log.info({ count: stale.length }, 'Cleaned stale temp files from previous run');
  }
}

async function start() {
  try {
    const tmpDir = config.tmpDir;
    await mkdir(tmpDir, { recursive: true });
    await mkdir(config.dataDir, { recursive: true });
    await sweepStaleTempFiles(tmpDir);
    await orgRegistry.load();
    orgRegistry.startFlushInterval();
    sessionManager.startCleanupInterval();
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }
}

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  let exitCode = 0;
  try {
    app.log.info('Shutting down...');
    sessionManager.stopCleanupInterval();
    orgRegistry.stopFlushInterval();
    await orgRegistry.flushLastUsedAt();
    await app.close();
    await sessionManager.destroyAll();
  } catch (err) {
    app.log.error(err, 'Error during shutdown');
    exitCode = 1;
  } finally {
    process.exit(exitCode);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start();

export default app;

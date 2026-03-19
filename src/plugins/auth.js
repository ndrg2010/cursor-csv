import { createHash, timingSafeEqual } from 'node:crypto';
import fp from 'fastify-plugin';

function constantTimeEqual(a, b) {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

async function authPlugin(fastify) {
  const adminApiKey = fastify.config.adminApiKey;

  if (!adminApiKey && (fastify.config.nodeEnv || process.env.NODE_ENV) === 'production') {
    throw new Error('ADMIN_API_KEY is required in production');
  }

  fastify.decorate('verifyAdminKey', async (request, reply) => {
    if (!adminApiKey) {
      request.log.warn('ADMIN_API_KEY not configured -- admin auth disabled');
      return;
    }

    const provided = request.headers['x-api-key'];
    if (!provided) {
      return reply.code(401).send({
        code: 'MISSING_API_KEY',
        message: 'X-API-Key header is required',
      });
    }

    if (!constantTimeEqual(provided, adminApiKey)) {
      request.log.warn({ ip: request.ip }, 'Failed admin auth attempt');
      return reply.code(403).send({
        code: 'INVALID_API_KEY',
        message: 'Invalid API key',
      });
    }
  });

  fastify.decorate('verifyOrgApiKey', async (request, reply) => {
    const provided = request.headers['x-api-key'];
    if (!provided) {
      return reply.code(401).send({
        code: 'MISSING_API_KEY',
        message: 'X-API-Key header is required',
      });
    }

    const org = fastify.orgRegistry.getOrgByApiKey(provided);
    if (!org) {
      request.log.warn({ ip: request.ip }, 'Failed org auth attempt');
      return reply.code(403).send({
        code: 'INVALID_API_KEY',
        message: 'Invalid API key',
      });
    }

    request.org = org;
  });
}

export default fp(authPlugin);

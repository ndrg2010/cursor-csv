/** @param {import('fastify').FastifyInstance} fastify */
async function healthRoutes(fastify) {
  fastify.get('/health', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            uptime: { type: 'integer' },
          },
        },
      },
    },
  }, async () => {
    return {
      status: 'ok',
      uptime: Math.floor(process.uptime()),
    };
  });

  fastify.get('/health/detail', {
    onRequest: [fastify.verifyAdminKey],
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            activeSessions: { type: 'integer' },
            maxSessions: { type: 'integer' },
            uptime: { type: 'integer' },
            memoryUsage: {
              type: 'object',
              properties: {
                rss: { type: 'integer' },
                heapUsed: { type: 'integer' },
                heapTotal: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  }, async () => {
    return {
      status: 'ok',
      activeSessions: fastify.sessionManager.sessionCount,
      maxSessions: fastify.config.csv.maxConcurrentSessions,
      uptime: Math.floor(process.uptime()),
      memoryUsage: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      },
    };
  });
}

export default healthRoutes;

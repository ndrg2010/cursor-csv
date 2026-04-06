const errorSchema = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
  },
};

/** @param {import('fastify').FastifyInstance} fastify */
async function csvRoutes(fastify) {
  fastify.addHook('onRequest', fastify.verifyOrgApiKey);

  // POST /v1/csv/init -- async init, returns immediately
  fastify.post('/init', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['contentVersionId', 'cursorBatchJobId'],
        properties: {
          contentVersionId: { type: 'string', minLength: 15, maxLength: 18, pattern: '^068[a-zA-Z0-9]{12,15}$' },
          cursorBatchJobId: { type: 'string', minLength: 15, maxLength: 18 },
        },
        additionalProperties: false,
      },
      response: {
        202: {
          type: 'object',
          properties: {
            csvQueryId: { type: 'string' },
            status: { type: 'string' },
            ttlSeconds: { type: 'integer' },
            expiresAt: { type: 'string' },
          },
        },
        400: errorSchema,
        429: errorSchema,
      },
    },
  }, async (request, reply) => {
    const { contentVersionId, cursorBatchJobId } = request.body;
    const session = fastify.sessionManager.createSession(contentVersionId, request.org.sfAuth, request.org.orgId, cursorBatchJobId);

    reply.code(202).send({
      csvQueryId: session.csvQueryId,
      status: session.status,
      ttlSeconds: fastify.config.csv.ttlSeconds,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  });

  // GET /v1/csv/:csvQueryId/status
  fastify.get('/:csvQueryId/status', {
    schema: {
      params: {
        type: 'object',
        properties: {
          csvQueryId: { type: 'string', pattern: '^cq_[a-f0-9]{32}$' },
        },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          properties: {
            csvQueryId: { type: 'string' },
            status: { type: 'string' },
            rowCount: { type: 'integer' },
            headers: { type: 'array', items: { type: 'string' } },
            columnTypes: { type: 'array', items: { type: 'string' } },
            ttlSeconds: { type: 'integer' },
            expiresAt: { type: 'string' },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
        404: errorSchema,
      },
    },
  }, async (request, reply) => {
    const { csvQueryId } = request.params;
    const session = fastify.sessionManager.getSessionForOrg(csvQueryId, request.org.orgId);

    if (!session) {
      reply.code(404).send({
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found',
      });
      return;
    }

    fastify.sessionManager.touch(csvQueryId);
    const base = { csvQueryId, status: session.status };

    if (session.status === 'ready') {
      return {
        ...base,
        rowCount: session.rowCount,
        headers: session.headers,
        columnTypes: session.columnTypes,
        ttlSeconds: fastify.config.csv.ttlSeconds,
        expiresAt: new Date(session.expiresAt).toISOString(),
      };
    }

    if (session.status === 'error') {
      return { ...base, error: session.error };
    }

    return base;
  });

  // GET /v1/csv/:csvQueryId/rows
  fastify.get('/:csvQueryId/rows', {
    schema: {
      params: {
        type: 'object',
        properties: {
          csvQueryId: { type: 'string', pattern: '^cq_[a-f0-9]{32}$' },
        },
        additionalProperties: false,
      },
      querystring: {
        type: 'object',
        required: ['start', 'count'],
        properties: {
          start: { type: 'integer', minimum: 0 },
          count: { type: 'integer', minimum: 1, maximum: 2000 },
        },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          properties: {
            csvQueryId: { type: 'string' },
            start: { type: 'integer' },
            count: { type: 'integer' },
            rows: { type: 'array' },
            hasMore: { type: 'boolean' },
            totalRows: { type: 'integer' },
          },
        },
        404: errorSchema,
        409: errorSchema,
      },
    },
  }, async (request, reply) => {
    const { csvQueryId } = request.params;
    const { start, count } = request.query;
    return fastify.sessionManager.queryRows(csvQueryId, start, count, request.org.orgId);
  });

  // GET /v1/csv/:csvQueryId/meta
  fastify.get('/:csvQueryId/meta', {
    schema: {
      params: {
        type: 'object',
        properties: {
          csvQueryId: { type: 'string', pattern: '^cq_[a-f0-9]{32}$' },
        },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          properties: {
            csvQueryId: { type: 'string' },
            status: { type: 'string' },
            rowCount: { type: 'integer' },
            headers: { type: 'array', items: { type: 'string' } },
            columnTypes: { type: 'array', items: { type: 'string' } },
            ttlSeconds: { type: 'integer' },
            expiresAt: { type: 'string' },
          },
        },
        404: errorSchema,
        409: errorSchema,
      },
    },
  }, async (request, reply) => {
    const { csvQueryId } = request.params;
    const session = fastify.sessionManager.getSessionForOrg(csvQueryId, request.org.orgId);

    if (!session) {
      reply.code(404).send({
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found',
      });
      return;
    }

    fastify.sessionManager.touch(csvQueryId);

    if (session.status !== 'ready') {
      reply.code(409).send({
        code: 'SESSION_NOT_READY',
        message: `Session is not ready (status: ${session.status})`,
      });
      return;
    }

    return {
      csvQueryId,
      status: session.status,
      rowCount: session.rowCount,
      headers: session.headers,
      columnTypes: session.columnTypes,
      ttlSeconds: fastify.config.csv.ttlSeconds,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  });

  // DELETE /v1/csv/:csvQueryId
  fastify.delete('/:csvQueryId', {
    schema: {
      params: {
        type: 'object',
        properties: {
          csvQueryId: { type: 'string', pattern: '^cq_[a-f0-9]{32}$' },
        },
        additionalProperties: false,
      },
      response: {
        204: { type: 'null' },
        404: errorSchema,
      },
    },
  }, async (request, reply) => {
    const { csvQueryId } = request.params;
    const session = fastify.sessionManager.getSessionForOrg(csvQueryId, request.org.orgId);
    if (!session) {
      reply.code(404).send({
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found',
      });
      return;
    }

    await fastify.sessionManager.destroySession(csvQueryId);
    reply.code(204).send();
  });
}

export default csvRoutes;

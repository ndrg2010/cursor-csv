const SF_DOMAIN_RE = /^https:\/\/[a-z0-9._-]+\.(my\.salesforce\.com|salesforce\.com|force\.com|cloudforce\.com|salesforce\.mil|sfcrmapps\.cn)(\/.*)?$/i;

const errorSchema = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
  },
};

const orgIdParam = {
  type: 'object',
  properties: {
    orgId: { type: 'string', pattern: '^org_[a-f0-9]{8}$' },
  },
  additionalProperties: false,
};

/** @param {import('fastify').FastifyInstance} fastify */
async function orgRoutes(fastify) {
  fastify.addHook('onRequest', fastify.verifyAdminKey);

  // POST /v1/orgs — register a new org
  fastify.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['loginUrl'],
        properties: {
          loginUrl: { type: 'string', format: 'uri', pattern: '^https://' },
          label: { type: 'string', maxLength: 255 },
        },
        additionalProperties: false,
      },
      response: {
        201: {
          type: 'object',
          properties: {
            orgId: { type: 'string' },
            apiKey: { type: 'string' },
            label: { type: 'string' },
          },
        },
        400: errorSchema,
        409: errorSchema,
      },
    },
  }, async (request, reply) => {
    const { loginUrl, label } = request.body;
    if (!SF_DOMAIN_RE.test(loginUrl.replace(/\/+$/, ''))) {
      return reply.code(400).send({
        code: 'INVALID_LOGIN_URL',
        message: 'loginUrl must be a Salesforce domain (*.salesforce.com, *.force.com, *.salesforce.mil)',
      });
    }
    const result = await fastify.orgRegistry.register(loginUrl, label);
    reply.code(201).send(result);
  });

  // GET /v1/orgs — list all registered orgs
  fastify.get('/', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            orgs: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  orgId: { type: 'string' },
                  label: { type: 'string' },
                  loginUrl: { type: 'string' },
                  registeredAt: { type: 'string' },
                  lastUsedAt: { type: ['string', 'null'] },
                },
              },
            },
          },
        },
      },
    },
  }, async () => {
    return { orgs: fastify.orgRegistry.list() };
  });

  // DELETE /v1/orgs/:orgId — remove an org
  fastify.delete('/:orgId', {
    schema: {
      params: orgIdParam,
      response: {
        204: { type: 'null' },
        404: errorSchema,
      },
    },
  }, async (request, reply) => {
    const removed = await fastify.orgRegistry.remove(request.params.orgId);
    if (!removed) {
      reply.code(404).send({
        code: 'ORG_NOT_FOUND',
        message: 'Org not found',
      });
      return;
    }
    reply.code(204).send();
  });

  // POST /v1/orgs/:orgId/rotate-key — rotate an org's API key
  fastify.post('/:orgId/rotate-key', {
    schema: {
      params: orgIdParam,
      response: {
        200: {
          type: 'object',
          properties: {
            apiKey: { type: 'string' },
          },
        },
        404: errorSchema,
      },
    },
  }, async (request, reply) => {
    const result = await fastify.orgRegistry.rotateKey(request.params.orgId);
    if (!result) {
      reply.code(404).send({
        code: 'ORG_NOT_FOUND',
        message: 'Org not found',
      });
      return;
    }
    return result;
  });
}

export default orgRoutes;

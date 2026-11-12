import Fastify, { type FastifyServerOptions } from 'fastify';

export function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify(options);

  app.get('/api/health', async () => ({
    ok: true,
    service: 'task-layout-engine',
  }));

  return app;
}

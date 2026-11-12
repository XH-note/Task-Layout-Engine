import { describe, expect, it } from 'vitest';

import { buildApp } from './app';

describe('GET /api/health', () => {
  it('reports that the local server is ready', async () => {
    const app = buildApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        service: 'task-layout-engine',
      });
    } finally {
      await app.close();
    }
  });
});

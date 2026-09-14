import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MemoryStore } from './helpers/memory-store.js';

describe('health endpoints', () => {
  it('reports real worker wrappers and retry backoff without running customer jobs', async () => {
    const app = createApp({ overrides: { store: new MemoryStore(), auth: {}, disableLegacy: true } });
    const workers = app.locals.container.workers;
    for (const worker of Object.values(workers)) vi.spyOn(worker.loop, 'schedule').mockImplementation(() => {});
    try {
      let result = await request(app).get('/health');
      for (const state of Object.values(result.body.workers)) expect(state.started).toBe(false);
      for (const worker of Object.values(workers)) worker.start();
      result = await request(app).get('/health');
      expect(Object.keys(result.body.workers).sort()).toEqual(['campaign', 'inbound', 'media', 'outbound']);
      for (const state of Object.values(result.body.workers)) expect(state.started).toBe(true);
      vi.spyOn(workers.outbound, 'tick').mockRejectedValueOnce(new Error('RESOURCE_EXHAUSTED')).mockResolvedValue(false);
      workers.outbound.loop.logger = { error: vi.fn() };
      await workers.outbound.loop.execute();
      result = await request(app).get('/health');
      expect(result.body.workers.outbound.failureCount).toBe(1);
      expect(result.body.workers.outbound.retryAfter).toBeGreaterThan(Date.now());
      expect(result.body.workers.outbound.executing).toBe(false);
      await workers.outbound.loop.execute();
      result = await request(app).get('/ready');
      expect(result.status).toBe(200);
      expect(result.body.workers.outbound.failureCount).toBe(0);
      expect(result.body.workers.outbound.retryAfter).toBeNull();
    } finally {
      for (const worker of Object.values(workers)) worker.stop();
      vi.restoreAllMocks();
    }
  });

  it('returns not-ready when the database read fails while health stays a process check', async () => {
    const store = new MemoryStore();
    const app = createApp({ overrides: { store, auth: {}, disableLegacy: true } });
    vi.spyOn(store, 'get').mockRejectedValue(new Error('database unavailable'));
    try {
      expect((await request(app).get('/health')).status).toBe(200);
      const result = await request(app).get('/ready');
      expect(result.status).toBe(503);
      expect(result.body.status).toBe('not_ready');
      expect(result.body).not.toHaveProperty('error');
    } finally { vi.restoreAllMocks(); }
  });
});

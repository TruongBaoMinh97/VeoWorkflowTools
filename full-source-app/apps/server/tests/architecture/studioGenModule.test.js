import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const service = vi.hoisted(() => ({
  listProjects: vi.fn(async () => []),
  createProject: vi.fn(async (data) => ({ id: 'studio-project', ...data })),
  updateProject: vi.fn(async (_id, data) => data),
  deleteAllProjects: vi.fn(async () => ({ deletedCount: 0 })),
  deleteOrphanProjects: vi.fn(async () => ({ deletedCount: 0 })),
}));
vi.mock('../../src/modules/genNormal/genNormal.service.js', () => ({ genNormalService: service }));

import { registerGenNormalRoutes } from '../../src/modules/genNormal/genNormal.routes.js';
import { ensureStudioUpscaleSerial } from '../../src/database/initialize.js';

describe('Veo3 Gen Studio project isolation', () => {
  it('routes Studio project actions to the Studio source', async () => {
    const app = Fastify();
    try {
      await app.register(registerGenNormalRoutes);
      expect((await app.inject('/api/gen-normal/projects?source=studio')).statusCode).toBe(200);
      expect(service.listProjects).toHaveBeenCalledWith('studio');

      const created = await app.inject({
        method: 'POST', url: '/api/gen-normal/projects',
        payload: { name: 'Studio test', profileIds: ['profile-1'], source: 'studio' },
      });
      expect(created.statusCode).toBe(201);
      expect(service.createProject).toHaveBeenCalledWith(expect.objectContaining({ source: 'studio' }));

      expect((await app.inject({ method: 'DELETE', url: '/api/gen-normal/projects?source=studio' })).statusCode).toBe(200);
      expect(service.deleteAllProjects).toHaveBeenCalledWith('studio');
      expect((await app.inject({ method: 'DELETE', url: '/api/gen-normal/projects/cleanup-orphans?source=studio' })).statusCode).toBe(200);
      expect(service.deleteOrphanProjects).toHaveBeenCalledWith('studio');
    } finally {
      await app.close();
      vi.clearAllMocks();
    }
  });

  it('adds the optional upscale setting without changing old project rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-gen-schema-'));
    const dbPath = path.join(dir, 'projects.db');
    try {
      const db = new Database(dbPath);
      db.exec('CREATE TABLE "GenNormalProject" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL)');
      db.prepare('INSERT INTO "GenNormalProject" ("id", "name") VALUES (?, ?)').run('old-project', 'Existing project');
      db.close();

      ensureStudioUpscaleSerial(dbPath);
      ensureStudioUpscaleSerial(dbPath);

      const migrated = new Database(dbPath, { readonly: true });
      expect(migrated.prepare('SELECT id, name, upscaleSerial FROM "GenNormalProject"').get())
        .toEqual({ id: 'old-project', name: 'Existing project', upscaleSerial: 0 });
      migrated.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

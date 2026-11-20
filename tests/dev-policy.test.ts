import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createServer } from 'vite';
import { assertPrivateStorage, createDevFileDeny } from '../server/dev-policy.js';

it('keeps private workspace data out of Vite static, raw-file and raw-import routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tutorflow-dev-policy-'));
  const marker = 'synthetic-private-fixture';
  for (const folder of [
    '.data',
    '.codex',
    '.agents',
    'docs',
    'runtime-db',
    'lesson-material',
    'boards[private]',
    'memory:/board-data',
  ]) {
    await mkdir(join(root, folder), { recursive: true });
    await writeFile(join(root, folder, 'private.txt'), marker);
  }
  await writeFile(join(root, 'public.txt'), 'public-fixture');
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: {
      middlewareMode: true,
      hmr: false,
      ws: false,
      watch: null,
      fs: {
        strict: true,
        allow: [root],
        deny: createDevFileDeny(
          ['runtime-db', 'lesson-material', 'boards[private]', 'memory://board-data'],
          root,
        ),
      },
    },
  });
  const app = express();
  app.use(vite.middlewares);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const base = `http://127.0.0.1:${address.port}`;
    expect(await (await fetch(`${base}/public.txt`)).text()).toBe('public-fixture');
    for (const folder of [
      '.data',
      '.codex',
      '.agents',
      'docs',
      'runtime-db',
      'lesson-material',
      'boards[private]',
      'memory:/board-data',
    ]) {
      for (const path of [
        `/${folder}/private.txt`,
        `/@fs${root}/${folder}/private.txt`,
        `/${folder}/private.txt?raw`,
        `/@fs${root}/${folder}/private.txt?raw&import`,
      ]) {
        const response = await fetch(`${base}${path}`);
        expect(response.status, path).toBe(403);
        expect(await response.text()).not.toContain(marker);
      }
    }
  } finally {
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
    await vite.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects storage in published trees, including symlinked and not-yet-created paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tutorflow-private-path-'));
  try {
    await mkdir(join(root, 'public'));
    await symlink(join(root, 'public'), join(root, 'alias'));
    for (const path of ['public/db', 'dist/client/boards', 'alias/not-created', '.']) {
      expect(() => assertPrivateStorage([path], root), path).toThrow('Private storage');
    }
    expect(() =>
      assertPrivateStorage(['runtime-db', 'lesson-material', 'memory://'], root),
    ).not.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

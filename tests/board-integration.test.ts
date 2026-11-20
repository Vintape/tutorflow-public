import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TLRecord } from '@tldraw/tlschema';
import { createDatabase, migrate, type Database } from '../server/db.js';
import { createApp } from '../server/app.js';
import { BoardRuntime } from '../server/boards/runtime.js';
import type { Config } from '../server/config.js';

const config: Config = {
  production: false,
  port: 0,
  appUrl: 'http://localhost:3187',
  secret: 'synthetic-integration-only-secret-111111111111111111111',
  databaseSSL: false,
  dataDir: 'memory://',
  aiModel: 'disabled',
  aiDailyLimit: 1,
  boardsEnabled: true,
};
let db: Database,
  runtime: BoardRuntime,
  server: Server,
  directory: string,
  base: string,
  cookie: string,
  boardId: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tutorflow-board-integration-'));
  db = await createDatabase(config);
  await migrate(db);
  runtime = await BoardRuntime.open(directory);
  server = createApp(db, config, undefined, runtime).app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No integration port');
  base = `http://127.0.0.1:${address.port}`;
  const response = await request('/api/auth/sign-up/email', {
    name: 'Synthetic integration tutor',
    email: `${randomUUID()}@example.test`,
    password: 'Synthetic-only-1122334455',
  });
  expect(response.status).toBe(200);
  cookie = response.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
  const created = await request('/api/boards', { title: 'Unicode code', requestId: randomUUID() });
  expect(created.status).toBe(201);
  boardId = ((await created.json()) as { id: string }).id;
  await runtime.run(boardId, (entry) =>
    entry.room.updateStore((store) =>
      store.put({
        id: 'shape:python',
        typeName: 'shape',
        type: 'code-python',
        x: 0,
        y: 0,
        rotation: 0,
        index: 'a1',
        parentId: 'page:page',
        isLocked: false,
        opacity: 1,
        meta: {},
        props: { w: 400, h: 280, source: '', version: 1 },
      } as TLRecord),
    ),
  );
});
afterAll(async () => {
  if (server)
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  await runtime?.close();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
function request(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Origin: config.appUrl, Cookie: cookie ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
it('accepts schema-valid Unicode Python through the actual application parser and persists it', async () => {
  const source = 'print("я")\n'.repeat(5000);
  expect(source.length).toBeLessThan(65536);
  expect(Buffer.byteLength(JSON.stringify({ source }))).toBeGreaterThan(65536);
  const response = await request(`/api/board-access/${boardId}/code/shape:python`, {
    expectedVersion: 1,
    source,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ version: 2 });
  expect(
    runtime.snapshot(boardId).document.documents.find((d) => d.state.id === 'shape:python')?.state,
  ).toMatchObject({ props: { source, version: 2 } });
});
it('bounds an oversized code body before mutation', async () => {
  const before = runtime.snapshot(boardId);
  const response = await request(`/api/board-access/${boardId}/code/shape:python`, {
    expectedVersion: 2,
    source: 'a'.repeat(310 * 1024),
  });
  expect(response.status).toBe(413);
  expect(runtime.snapshot(boardId)).toEqual(before);
});
it('exposes an authenticated durable content proof that changes with canonical source', async () => {
  const beforeRead = runtime.snapshot(boardId);
  const response = await fetch(`${base}/api/board-access/${boardId}/status`, {
    headers: { Cookie: cookie },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const first = (await response.json()) as { documentClock: number; fingerprint: string };
  expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(first.documentClock).toBeGreaterThan(0);
  expect(runtime.snapshot(boardId)).toEqual(beforeRead);
  const updated = await request(`/api/board-access/${boardId}/code/shape:python`, {
    expectedVersion: 2,
    source: 'print("changed")',
  });
  expect(updated.status).toBe(200);
  const second = (await (
    await fetch(`${base}/api/board-access/${boardId}/status`, { headers: { Cookie: cookie } })
  ).json()) as { documentClock: number; fingerprint: string };
  expect(second.fingerprint).not.toBe(first.fingerprint);
  expect(second.documentClock).toBeGreaterThan(first.documentClock);
  const anonymous = await fetch(`${base}/api/board-access/${boardId}/status`);
  expect(anonymous.status).toBe(404);
  expect(await anonymous.text()).not.toContain('fingerprint');
});
it('deletes board files only after committing the owner tombstone and supports retry', async () => {
  await access(join(directory, `${boardId}.sqlite`));
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${base}/api/boards/${boardId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie, Origin: config.appUrl },
    });
    expect(response.status).toBe(200);
    await expect(access(join(directory, `${boardId}.sqlite`))).rejects.toThrow();
  }
  expect(
    (await fetch(`${base}/api/boards/${boardId}`, { headers: { Cookie: cookie } })).status,
  ).toBe(404);
});

import express, { type Request, type Response, type NextFunction } from 'express';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import type { TLRecord } from '@tldraw/tlschema';
import { createDatabase, migrate, type Database } from '../server/db.js';
import { createAuth } from '../server/auth.js';
import type { Config } from '../server/config.js';
import { AppError } from '../server/errors.js';
import { BoardService } from '../server/boards/service.js';
import { BoardRuntime } from '../server/boards/runtime.js';
import { mountBoardAccess, mountBoardOwners, type BoardContext } from '../server/boards/http.js';
import type { Board, BoardInvitation } from '../shared/boards.js';

const config: Config = {
  production: false,
  port: 3191,
  appUrl: 'http://localhost:3191',
  secret: 'synthetic-board-api-secret-only-123456789012345',
  databaseSSL: false,
  dataDir: 'memory://',
  aiModel: 'unused',
  aiDailyLimit: 20,
};
let db: Database, runtime: BoardRuntime, server: Server, base: string, directory: string;
let context: BoardContext,
  cookieA = '',
  cookieB = '',
  ownerA = '';
function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  void _next;
  res
    .status(error instanceof AppError ? error.status : error instanceof z.ZodError ? 422 : 500)
    .json({ code: error instanceof AppError ? error.code : 'VALIDATION' });
}
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = cookieA,
  origin: string | undefined = config.appUrl,
) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      ...(origin ? { Origin: origin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function json<T>(response: globalThis.Response, status = 200): Promise<T> {
  const data = await response.json();
  expect(response.status, JSON.stringify(data)).toBe(status);
  return data as T;
}
function cookie(response: globalThis.Response) {
  return response.headers
    .getSetCookie()
    .map((item) => item.split(';')[0])
    .join('; ');
}
async function create(title = 'Synthetic board') {
  return json<Board>(await request('/api/boards', 'POST', { title, requestId: randomUUID() }), 201);
}
async function invite(id: string, role: 'editor' | 'viewer' = 'viewer', maxUses = 2) {
  return json<{ invite: BoardInvitation; token: string }>(
    await request(`/api/boards/${id}/invites`, 'POST', { role, ttlMinutes: 60, maxUses }),
    201,
  );
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tutorflow-board-api-'));
  db = await createDatabase({ dataDir: 'memory://' });
  await migrate(db);
  runtime = await BoardRuntime.open(directory, { lockRetries: 0 });
  const auth = createAuth(db, config);
  context = { db, config, auth, boards: new BoardService(db), runtime };
  const app = express();
  app.all('/api/auth/{*splat}', toNodeHandler(auth));
  app.use(express.json({ limit: '128kb' }));
  app.use((req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('Origin') !== config.appUrl)
      return next(new AppError(403, 'Origin', 'ORIGIN'));
    next();
  });
  mountBoardAccess(app, context);
  app.use(async (req, res, next) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) return next(new AppError(401, 'Login'));
    res.locals.user = session.user;
    next();
  });
  mountBoardOwners(app, context);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port');
  base = `http://127.0.0.1:${address.port}`;
  for (const name of ['a', 'b']) {
    const response = await request(
      '/api/auth/sign-up/email',
      'POST',
      {
        name: `Synthetic ${name}`,
        email: `${name}@board-api.test`,
        password: 'OnlySyntheticPassword123!',
      },
      '',
    );
    const user = await json<{ user: { id: string } }>(response);
    if (name === 'a') {
      cookieA = cookie(response);
      ownerA = user.user.id;
    } else cookieB = cookie(response);
  }
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  await runtime?.close();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('creates and retries an ACTIVE independent board and protects foreign metadata without mutation', async () => {
  const requestId = randomUUID();
  const board = await json<Board>(
    await request('/api/boards', 'POST', { title: 'First', requestId }),
    201,
  );
  expect(board.state).toBe('ACTIVE');
  expect(
    await json(await request('/api/boards', 'POST', { title: 'Ignored', requestId }), 201),
  ).toEqual(board);
  const before = runtime.snapshot(board.id);
  for (const [path, method, body] of [
    [`/api/boards/${board.id}`, 'GET', undefined],
    [`/api/boards/${board.id}`, 'PATCH', { title: 'Foreign' }],
    [`/api/boards/${board.id}/export`, 'GET', undefined],
    [`/api/boards/${board.id}/invites`, 'POST', { role: 'editor', ttlMinutes: 5 }],
    [`/api/boards/${board.id}`, 'DELETE', undefined],
  ] as const)
    expect((await request(path, method, body, cookieB)).status).toBe(404);
  expect(runtime.snapshot(board.id)).toEqual(before);
  expect((await context.boards.get(ownerA, board.id)).title).toBe('First');
});
it('uses explicit redemption and a board-path scoped HttpOnly Strict cookie without exposing the raw session', async () => {
  const board = await create();
  const invitation = await invite(board.id);
  const before = await db.query('SELECT uses FROM board_invitations WHERE id=$1', [
    invitation.invite.id,
  ]);
  expect(
    (
      await request(
        `/api/board-access/${board.id}/redeem?token=${invitation.token}`,
        'GET',
        undefined,
        '',
      )
    ).status,
  ).toBe(404);
  expect(
    await db.query('SELECT uses FROM board_invitations WHERE id=$1', [invitation.invite.id]),
  ).toEqual(before);
  expect(
    (
      await request(
        `/api/board-access/${board.id}/redeem`,
        'POST',
        { token: invitation.token },
        '',
        'https://foreign.test',
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        `/api/board-access/${board.id}/redeem`,
        'POST',
        { token: invitation.token },
        '',
        '',
      )
    ).status,
  ).toBe(403);
  const response = await request(
    `/api/board-access/${board.id}/redeem`,
    'POST',
    { token: invitation.token },
    '',
  );
  const header = response.headers.getSetCookie()[0];
  expect(header).toContain('HttpOnly');
  expect(header).toContain('SameSite=Strict');
  expect(header).toContain(`Path=/api/board-access/${board.id}`);
  const data = await json<Record<string, unknown>>(response);
  const guestCookie = cookie(response);
  const raw = guestCookie.split('=')[1];
  expect(raw).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(data)).not.toContain(raw);
  const session = await json<Record<string, unknown>>(
    await request(`/api/board-access/${board.id}/session`, 'GET', undefined, guestCookie),
  );
  expect(session).toMatchObject({ boardId: board.id, title: board.title, role: 'viewer' });
  expect(JSON.stringify(session)).not.toMatch(/ownerId|student|invitation|token|digest/i);
  expect((await request(`/api/boards/${board.id}`, 'GET', undefined, guestCookie)).status).toBe(
    401,
  );
  const another = await create();
  expect(
    (await request(`/api/board-access/${another.id}/session`, 'GET', undefined, guestCookie))
      .status,
  ).toBe(404);
  expect(
    (
      await request(
        `/api/board-access/${board.id}/session?token=${invitation.token}`,
        'GET',
        undefined,
        '',
      )
    ).status,
  ).toBe(404);
});
it('exports only canvas data to guests and denies viewer code edits with unchanged clock/source', async () => {
  const board = await create();
  await runtime.run(board.id, (entry) =>
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
  const invitation = await invite(board.id);
  const redemption = await request(
    `/api/board-access/${board.id}/redeem`,
    'POST',
    { token: invitation.token },
    '',
  );
  await json(redemption);
  const guestCookie = cookie(redemption);
  const before = runtime.snapshot(board.id);
  const exported = await json(
    await request(`/api/board-access/${board.id}/export`, 'GET', undefined, guestCookie),
  );
  expect(exported).toEqual(before);
  expect(
    (
      await request(
        `/api/board-access/${board.id}/code/shape:python`,
        'POST',
        { expectedVersion: 1, source: 'print(1)' },
        guestCookie,
      )
    ).status,
  ).toBe(403);
  expect(runtime.snapshot(board.id)).toEqual(before);
  expect(
    await json(
      await request(`/api/board-access/${board.id}/code/shape:python`, 'POST', {
        expectedVersion: 1,
        source: 'print(1)',
      }),
    ),
  ).toEqual({ version: 2 });
  expect(
    (
      await request(`/api/board-access/${board.id}/code/shape:python`, 'POST', {
        expectedVersion: 1,
        source: 'print(2)',
      })
    ).status,
  ).toBe(409);
});
it('revokes guest HTTP access and prevents reconnect/redemption while preserving the board', async () => {
  const board = await create(),
    invitation = await invite(board.id);
  const redemption = await request(
    `/api/board-access/${board.id}/redeem`,
    'POST',
    { token: invitation.token },
    '',
  );
  await json(redemption);
  const guestCookie = cookie(redemption);
  const before = runtime.snapshot(board.id);
  await json(
    await request(`/api/boards/${board.id}/invites/${invitation.invite.id}/revoke`, 'POST', {}),
  );
  expect(
    (await request(`/api/board-access/${board.id}/session`, 'GET', undefined, guestCookie)).status,
  ).toBe(404);
  expect(
    (await request(`/api/board-access/${board.id}/export`, 'GET', undefined, guestCookie)).status,
  ).toBe(404);
  expect(
    (await request(`/api/board-access/${board.id}/redeem`, 'POST', { token: invitation.token }, ''))
      .status,
  ).toBe(404);
  expect(runtime.snapshot(board.id)).toEqual(before);
});
it('copies immutable history to an independent board without invitations and validates snapshot links', async () => {
  const board = await create('Source');
  await invite(board.id);
  const version = await json<{ id: string; label: string }>(
    await request(`/api/boards/${board.id}/versions`, 'POST', { label: 'Lesson 1' }),
    201,
  );
  expect(await json(await request(`/api/boards/${board.id}/versions`))).toMatchObject([
    { id: version.id, label: 'Lesson 1' },
  ]);
  const requestId = randomUUID();
  const copy = await json<Board>(
    await request(`/api/boards/${board.id}/copy`, 'POST', {
      requestId,
      title: 'Independent',
      snapshotId: version.id,
    }),
    201,
  );
  expect(copy.id).not.toBe(board.id);
  expect(copy.title).toBe('Independent');
  expect(await context.boards.listInvites(ownerA, copy.id)).toEqual([]);
  const saved = await json(await request(`/api/boards/${board.id}/versions/${version.id}/export`));
  expect((saved as { document: unknown }).document).toEqual(runtime.snapshot(copy.id).document);
  expect(
    (
      await request(`/api/boards/${board.id}/copy`, 'POST', {
        requestId: randomUUID(),
        snapshotId: randomUUID(),
      })
    ).status,
  ).toBe(404);
  const studentId = randomUUID(),
    lessonId = randomUUID();
  await db.query(
    'INSERT INTO students (id,"ownerId",name,subject,price,duration) VALUES ($1,$2,$3,$3,0,60)',
    [studentId, ownerA, 'Synthetic'],
  );
  await db.query(
    'INSERT INTO lessons (id,"ownerId","studentId","startsAt",duration,price) VALUES ($1,$2,$3,now(),60,0)',
    [lessonId, ownerA, studentId],
  );
  expect(
    (await request(`/api/boards/${board.id}/links`, 'POST', { lessonId, snapshotId: randomUUID() }))
      .status,
  ).toBe(404);
  expect(await context.boards.links(ownerA, board.id)).toEqual({ students: [], lessons: [] });
  await json(
    await request(`/api/boards/${board.id}/links`, 'POST', {
      lessonId,
      studentId,
      snapshotId: version.id,
    }),
  );
  await json(await request(`/api/boards/${board.id}/links`, 'DELETE', { lessonId, studentId }));
  expect(await context.boards.links(ownerA, board.id)).toEqual({ students: [], lessons: [] });
});
it('tombstones incomplete/missing-file boards and makes delete retries safe', async () => {
  const pending = await context.boards.create(ownerA, {
    title: 'No initialized file',
    requestId: randomUUID(),
  });
  await json(await request(`/api/boards/${pending.id}`, 'DELETE'));
  await json(await request(`/api/boards/${pending.id}`, 'DELETE'));
  expect((await request(`/api/boards/${pending.id}`)).status).toBe(404);
  const board = await create();
  const invitation = await invite(board.id);
  await json(await request(`/api/boards/${board.id}`, 'DELETE'));
  expect(
    (await request(`/api/board-access/${board.id}/redeem`, 'POST', { token: invitation.token }, ''))
      .status,
  ).toBe(404);
});
it('disables board APIs when runtime/license is unavailable while preserving other app routes', async () => {
  const previous = context.runtime;
  context.runtime = undefined;
  expect((await request('/api/boards')).status).toBe(503);
  context.runtime = previous;
  config.production = true;
  expect((await request('/api/boards')).status).toBe(503);
  config.production = false;
});

it('returns identical safe SDK metadata on redemption and reload, with Secure cookies for HTTPS', async () => {
  const board = await create(),
    invitation = await invite(board.id);
  const appUrl = config.appUrl,
    licenseKey = config.boardLicenseKey;
  try {
    config.appUrl = 'https://synthetic-board.test';
    config.boardLicenseKey = 'synthetic-public-sdk-license';
    const response = await request(
      `/api/board-access/${board.id}/redeem`,
      'POST',
      { token: invitation.token },
      '',
    );
    const data = await json<Record<string, unknown>>(response);
    expect(data.licenseKey).toBe('synthetic-public-sdk-license');
    expect(response.headers.getSetCookie()[0]).toContain('Secure');
    expect(
      await json(
        await request(`/api/board-access/${board.id}/session`, 'GET', undefined, cookie(response)),
      ),
    ).toEqual(data);
  } finally {
    config.appUrl = appUrl;
    config.boardLicenseKey = licenseKey;
  }
});

async function isolatedAccess() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  mountBoardAccess(app, context);
  app.use(errorHandler);
  const temporary = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => temporary.once('listening', resolve));
  const address = temporary.address();
  if (!address || typeof address === 'string') throw new Error('No isolated port');
  const url = `http://127.0.0.1:${address.port}`;
  return {
    send: (path: string, method = 'GET', body?: unknown, sessionCookie = '') =>
      fetch(`${url}${path}`, {
        method,
        headers: {
          Origin: config.appUrl,
          'Content-Type': 'application/json',
          Cookie: sessionCookie,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    close: () =>
      new Promise<void>((resolve) => {
        temporary.close(() => resolve());
        temporary.closeAllConnections();
      }),
  };
}
async function storedAccess(id: string) {
  return {
    invites: await db.query('SELECT * FROM board_invitations WHERE "boardId"=$1 ORDER BY id', [id]),
    sessions: await db.query('SELECT * FROM board_guest_sessions WHERE "boardId"=$1 ORDER BY id', [
      id,
    ]),
    board: await db.query('SELECT * FROM boards WHERE id=$1', [id]),
  };
}
it('limits explicit redemption before further sessions are minted and isolates fresh app counters', async () => {
  const board = await create(),
    invitation = await context.boards.createInvite(ownerA, board.id, {
      role: 'viewer',
      ttlMinutes: 60,
      maxUses: 100,
    });
  const limited = await isolatedAccess(),
    fresh = await isolatedAccess();
  try {
    for (let i = 0; i < 12; i++)
      await json(
        await limited.send(`/api/board-access/${board.id}/redeem`, 'POST', {
          token: invitation.token,
        }),
      );
    const before = await storedAccess(board.id),
      document = runtime.snapshot(board.id);
    const rejected = await limited.send(`/api/board-access/${board.id}/redeem`, 'POST', {
      token: invitation.token,
    });
    expect(await json(rejected, 429)).toEqual({
      error: 'Слишком много запросов к доске. Повторите через минуту.',
      code: 'RATE_LIMIT',
    });
    expect(Number(rejected.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await storedAccess(board.id)).toEqual(before);
    expect(runtime.snapshot(board.id)).toEqual(document);
    await json(
      await fresh.send(`/api/board-access/${board.id}/redeem`, 'POST', { token: invitation.token }),
    );
  } finally {
    await limited.close();
    await fresh.close();
  }
});
it('caps full canvas exports more tightly without changing room state or guest authorization data', async () => {
  const board = await create(),
    invitation = await context.boards.createInvite(ownerA, board.id, {
      role: 'viewer',
      ttlMinutes: 60,
      maxUses: 1,
    });
  const grant = await context.boards.redeem(board.id, invitation.token),
    sessionCookie = `tutorflow_board_session=${grant.token}`;
  const api = await isolatedAccess();
  try {
    const before = await storedAccess(board.id),
      document = runtime.snapshot(board.id);
    for (let i = 0; i < 6; i++)
      expect(
        await json(
          await api.send(`/api/board-access/${board.id}/export`, 'GET', undefined, sessionCookie),
        ),
      ).toEqual(document);
    expect(
      (await api.send(`/api/board-access/${board.id}/export`, 'GET', undefined, sessionCookie))
        .status,
    ).toBe(429);
    expect(await storedAccess(board.id)).toEqual(before);
    expect(runtime.snapshot(board.id)).toEqual(document);
    await json(
      await api.send(`/api/board-access/${board.id}/session`, 'GET', undefined, sessionCookie),
    );
  } finally {
    await api.close();
  }
});
it('bounds anonymous scoped HTTP requests across board IDs before owner or guest authentication', async () => {
  const board = await create(),
    api = await isolatedAccess();
  try {
    const before = await storedAccess(board.id),
      document = runtime.snapshot(board.id);
    for (let i = 0; i < 120; i++)
      expect(
        (await api.send(`/api/board-access/${i % 2 ? board.id : randomUUID()}/session`)).status,
      ).toBe(404);
    const rejected = await api.send(`/api/board-access/${randomUUID()}/session`);
    expect(rejected.status).toBe(429);
    expect(((await rejected.json()) as { code: string }).code).toBe('RATE_LIMIT');
    expect(await storedAccess(board.id)).toEqual(before);
    expect(runtime.snapshot(board.id)).toEqual(document);
  } finally {
    await api.close();
  }
});

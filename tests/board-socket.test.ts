import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as syncCore from '@tldraw/sync-core';
import { atom } from '@tldraw/state';
import { Store } from '@tldraw/store';
import type { TLRecord, TLInstancePresence, TLStoreProps, TLUser } from '@tldraw/tlschema';
// Installed 5.6.0 exports this helper at runtime but excludes its internal declaration.
const { getTlsyncProtocolVersion } = syncCore as unknown as {
  getTlsyncProtocolVersion: () => number;
};
import { boardSchema } from '../shared/board-schema.js';
import { createDatabase, migrate, type Database } from '../server/db.js';
import { createApp } from '../server/app.js';
import type { Config } from '../server/config.js';
import { BoardRuntime } from '../server/boards/runtime.js';
import { attachBoardSockets } from '../server/boards/socket.js';
import type { BoardContext } from '../server/boards/http.js';

const config: Config = {
  production: false,
  port: 3192,
  appUrl: 'http://localhost:3192',
  secret: 'synthetic-board-socket-secret-only-123456789012345',
  databaseSSL: false,
  dataDir: 'memory://',
  aiModel: 'unused',
  aiDailyLimit: 20,
};
let db: Database,
  runtime: BoardRuntime,
  server: Server,
  context: BoardContext,
  base: string,
  dir: string,
  owner: string,
  ownerCookie = '',
  foreignCookie = '';
let sockets: ReturnType<typeof attachBoardSockets>;
const clients = new Set<WebSocket>();
const inbox = new WeakMap<WebSocket, Record<string, unknown>[]>();
const liveClients: LiveClient[] = [];
const oldRAF = globalThis.requestAnimationFrame,
  oldCancelRAF = globalThis.cancelAnimationFrame;
function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((item) => item.split(';')[0])
    .join('; ');
}
async function request(path: string, method = 'GET', body?: unknown, cookie = ownerCookie) {
  return fetch(`${base}${path}`, {
    method,
    headers: { Origin: config.appUrl, 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function newBoard() {
  const b = await context.boards.create(owner, {
    title: 'Synthetic socket board',
    requestId: randomUUID(),
  });
  runtime.ensure(b.id);
  await context.boards.activate(owner, b.id);
  return b.id;
}
async function guest(id: string, role: 'editor' | 'viewer' = 'editor') {
  const invite = await context.boards.createInvite(owner, id, {
    role,
    ttlMinutes: 60,
    maxUses: 10,
  });
  const response = await request(
    `/api/board-access/${id}/redeem`,
    'POST',
    { token: invite.token },
    '',
  );
  expect(response.status).toBe(200);
  return { cookie: cookies(response), invite };
}
async function attempt(
  id: string,
  cookie = '',
  query = `sessionId=${randomUUID()}`,
  origin: string | undefined = config.appUrl,
  targetBase = base,
): Promise<WebSocket | number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${targetBase.replace('http:', 'ws:')}/api/board-access/${id}/sync?${query}`,
      { headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) } },
    );
    clients.add(ws);
    inbox.set(ws, []);
    ws.on('message', (data) => {
      inbox.get(ws)!.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, response) => {
      response.resume();
      resolve(response.statusCode!);
      ws.terminate();
    });
    ws.on('error', (error) => {
      if (ws.readyState === WebSocket.CONNECTING) reject(error);
    });
  });
}
async function open(id: string, cookie = ownerCookie, query?: string) {
  const result = await attempt(id, cookie, query);
  if (typeof result === 'number') throw new Error(`Upgrade returned ${result}`);
  return result;
}
async function waitMessage(
  ws: WebSocket,
  predicate: (data: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const previous = inbox.get(ws)!.find(predicate);
  if (previous) return previous;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Expected socket message not received'));
    }, 3000);
    const onMessage = (raw: WebSocket.RawData) => {
      const value = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (predicate(value)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(value);
      }
    };
    ws.on('message', onMessage);
  });
}
async function closed(ws: WebSocket) {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket did not close')), 3000);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
async function handshake(ws: WebSocket) {
  ws.send(
    JSON.stringify({
      type: 'connect',
      connectRequestId: randomUUID(),
      lastServerClock: -1,
      protocolVersion: getTlsyncProtocolVersion(),
      schema: boardSchema.serialize(),
    }),
  );
  return waitMessage(ws, (data) => data.type === 'connect');
}
function shape(id: string, source = 'x^2') {
  return {
    id: `shape:${id}`,
    typeName: 'shape',
    type: 'math-formula',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a1',
    parentId: 'page:page',
    isLocked: false,
    opacity: 1,
    meta: {},
    props: { w: 240, h: 100, source },
  };
}
function push(ws: WebSocket, id: string, clientClock = 1) {
  ws.send(
    JSON.stringify({ type: 'push', clientClock, diff: { [`shape:${id}`]: ['put', shape(id)] } }),
  );
}
async function acknowledged(ws: WebSocket, clock = 1) {
  await waitMessage(
    ws,
    (data) =>
      (data.type === 'push_result' && data.clientClock === clock) ||
      (data.type === 'data' &&
        (data.data as Record<string, unknown>[]).some(
          (item) => item.type === 'push_result' && item.clientClock === clock,
        )),
  );
}
beforeAll(async () => {
  globalThis.requestAnimationFrame = (callback) =>
    setTimeout(() => callback(performance.now()), 16) as unknown as number;
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  dir = await mkdtemp(join(tmpdir(), 'tutorflow-board-socket-'));
  db = await createDatabase({ dataDir: 'memory://' });
  await migrate(db);
  runtime = await BoardRuntime.open(dir, { lockRetries: 0 });
  const created = createApp(db, config, undefined, runtime);
  context = created.boardContext;
  server = created.app.listen(0, '127.0.0.1');
  sockets = attachBoardSockets(server, context);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('port');
  base = `http://127.0.0.1:${addr.port}`;
  for (const name of ['owner', 'foreign']) {
    const response = await request(
      '/api/auth/sign-up/email',
      'POST',
      {
        name: `Synthetic ${name}`,
        email: `${name}@board-socket.test`,
        password: 'OnlySyntheticPassword123!',
      },
      '',
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { user: { id: string } };
    if (name === 'owner') {
      owner = data.user.id;
      ownerCookie = cookies(response);
    } else foreignCookie = cookies(response);
  }
});
afterEach(async () => {
  for (const client of liveClients.splice(0)) client.close();
  for (const client of clients) {
    client.terminate();
    await closed(client);
  }
  clients.clear();
});
afterAll(async () => {
  globalThis.requestAnimationFrame = oldRAF;
  globalThis.cancelAnimationFrame = oldCancelRAF;
  await sockets?.close();
  if (server)
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  await runtime?.close();
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

it('rejects anonymous/foreign upgrades, missing/foreign Origin, bearer query and invalid identifiers without state changes', async () => {
  const id = await newBoard(),
    before = runtime.snapshot(id);
  expect(await attempt(id)).toBe(404);
  expect(await attempt(id, foreignCookie)).toBe(404);
  expect(await attempt(id, ownerCookie, `sessionId=${randomUUID()}`, 'https://foreign.test')).toBe(
    403,
  );
  expect(await attempt(id, ownerCookie, `sessionId=${randomUUID()}`, '')).toBe(403);
  expect(await attempt(id, ownerCookie, `sessionId=x&token=${'a'.repeat(64)}`)).toBe(422);
  expect(await attempt(id, ownerCookie, 'sessionId=')).toBe(422);
  expect(await attempt('not-uuid', ownerCookie)).toBe(422);
  expect(runtime.snapshot(id)).toEqual(before);
});
it('accepts independent owner/editor clients and durably stores both native pushes', async () => {
  const id = await newBoard(),
    g = await guest(id);
  const a = await open(id),
    b = await open(id, g.cookie);
  expect((await handshake(a)).isReadonly).toBe(false);
  expect((await handshake(b)).isReadonly).toBe(false);
  push(a, 'owner');
  push(b, 'guest');
  await Promise.all([acknowledged(a), acknowledged(b)]);
  const records = runtime.snapshot(id).document.documents.map((item) => item.state.id);
  expect(records).toContain('shape:owner');
  expect(records).toContain('shape:guest');
});
it('discards viewer writes without changing records or clock and keeps receiving peer edits', async () => {
  const id = await newBoard(),
    g = await guest(id, 'viewer'),
    ws = await open(id, g.cookie);
  const connection = await handshake(ws);
  expect(connection.isReadonly).toBe(true);
  expect(connection.objectAccess).toBe('read');
  const before = runtime.snapshot(id);
  push(ws, 'forbidden');
  await acknowledged(ws);
  expect(ws.readyState).toBe(WebSocket.OPEN);
  expect(runtime.snapshot(id)).toEqual(before);
  const owner = await open(id, ownerCookie);
  await handshake(owner);
  push(owner, 'later-owner-edit');
  await acknowledged(owner);
  await waitMessage(ws, (message) => JSON.stringify(message).includes('shape:later-owner-edit'));
  expect(runtime.snapshot(id).document.documents.some((item) => item.state.id === 'shape:forbidden')).toBe(false);
});
it('closes already-connected revoked guests and denies reconnect and all later mutations', async () => {
  const id = await newBoard(),
    g = await guest(id),
    ws = await open(id, g.cookie);
  await handshake(ws);
  push(ws, 'accepted');
  await acknowledged(ws);
  const response = await request(
    `/api/boards/${id}/invites/${g.invite.invite.id}/revoke`,
    'POST',
    {},
  );
  expect(response.status).toBe(200);
  const before = runtime.snapshot(id);
  await closed(ws);
  expect(await attempt(id, g.cookie)).toBe(404);
  expect(runtime.snapshot(id)).toEqual(before);
});
it('rechecks invitation validity on every inbound frame rather than relying on cached connect authorization', async () => {
  const id = await newBoard(),
    g = await guest(id),
    ws = await open(id, g.cookie);
  await handshake(ws);
  await db.query('UPDATE board_invitations SET "revokedAt"=clock_timestamp() WHERE id=$1', [
    g.invite.invite.id,
  ]);
  const before = runtime.snapshot(id);
  push(ws, 'after-revoke');
  await closed(ws);
  expect(runtime.snapshot(id)).toEqual(before);
});
it('enforces guest expiry on idle connections and denies expired reconnects', async () => {
  const id = await newBoard(),
    g = await guest(id);
  const raw = g.cookie.split('=')[1];
  await db.query(
    `UPDATE board_guest_sessions SET "expiresAt"=clock_timestamp()+interval '350 milliseconds' WHERE "boardId"=$1`,
    [id],
  );
  expect(raw).toHaveLength(64);
  const ws = await open(id, g.cookie);
  await handshake(ws);
  const before = runtime.snapshot(id);
  await closed(ws);
  expect(await attempt(id, g.cookie)).toBe(404);
  expect(runtime.snapshot(id)).toEqual(before);
});
it('rejects malformed/binary/oversized frames before native storage mutation', async () => {
  const id = await newBoard();
  for (const frame of ['{bad-json', Buffer.from('binary'), 'x'.repeat(512 * 1024 + 1)]) {
    const ws = await open(id);
    await handshake(ws);
    const before = runtime.snapshot(id);
    ws.send(frame);
    await closed(ws);
    expect(runtime.snapshot(id)).toEqual(before);
  }
});
it('caps room sockets at eight without displacing existing authorized sockets', async () => {
  const id = await newBoard();
  const opened: WebSocket[] = [];
  for (let i = 0; i < 8; i++) opened.push(await open(id));
  expect(await attempt(id, ownerCookie)).toBe(429);
  expect(opened.every((ws) => ws.readyState === WebSocket.OPEN)).toBe(true);
});

it('namespaces client-chosen session IDs so a guest cannot replace the owner native session', async () => {
  const id = await newBoard(),
    g = await guest(id);
  const query = 'sessionId=same-client-tab';
  const a = await open(id, ownerCookie, query);
  await handshake(a);
  const b = await open(id, g.cookie, query);
  await handshake(b);
  push(a, 'owner-still-authorized');
  push(b, 'guest-isolated');
  await Promise.all([acknowledged(a), acknowledged(b)]);
  expect(runtime.snapshot(id).document.documents.map((item) => item.state.id)).toEqual(
    expect.arrayContaining(['shape:owner-still-authorized', 'shape:guest-isolated']),
  );
});
it('closes an abusive socket when its bounded queue fills while the board operation gate is occupied', async () => {
  const id = await newBoard(),
    ws = await open(id);
  await handshake(ws);
  const before = runtime.snapshot(id);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const block = runtime.order(id, () => {
    entered();
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await started;
  try {
    for (let i = 0; i < 65; i++) ws.send(JSON.stringify({ type: 'ping' }));
    await closed(ws);
  } finally {
    release();
    await block;
  }
  await runtime.order(id, () => {});
  expect(runtime.snapshot(id)).toEqual(before);
});

async function upgradeServer() {
  const temporary = createServer();
  const access = attachBoardSockets(temporary, context);
  temporary.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => temporary.once('listening', resolve));
  const address = temporary.address();
  if (!address || typeof address === 'string') throw new Error('No isolated upgrade port');
  return {
    server: temporary,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await access.close();
      await new Promise<void>((resolve) => temporary.close(() => resolve()));
    },
  };
}
async function outcomeWithin<T>(
  work: Promise<T>,
  milliseconds: number,
): Promise<T | 'still-pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<'still-pending'>((resolve) => {
        timer = setTimeout(() => resolve('still-pending'), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
it('closes a real ws client when its server outbound buffer exceeds the bounded budget', async () => {
  const id = await newBoard(),
    ws = await open(id);
  await handshake(ws);
  const before = runtime.snapshot(id);
  const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')!;
  const blocked = vi
    .spyOn(WebSocket.prototype, 'bufferedAmount', 'get')
    .mockImplementation(function (this: WebSocket) {
      return this.url ? (descriptor.get!.call(this) as number) : 9 * 1024 * 1024 + 1;
    });
  let code = 0;
  ws.once('close', (value) => {
    code = value;
  });
  try {
    ws.send(JSON.stringify({ type: 'ping' }));
    await closed(ws);
    expect(code).toBe(1009);
    expect(runtime.snapshot(id)).toEqual(before);
  } finally {
    blocked.mockRestore();
  }
});
it('bounds pending upgrades before queued authorization and releases reservations after completion', async () => {
  const id = await newBoard(),
    isolated = await upgradeServer();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const block = runtime.order(id, () => {
    entered();
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await started;
  const pending: Promise<WebSocket | number>[] = [];
  let arrivals = 0;
  const observe = () => {
    arrivals++;
  };
  isolated.server.on('upgrade', observe);
  try {
    for (let i = 0; i < 16; i++)
      pending.push(attempt(id, ownerCookie, `sessionId=pending-${i}`, config.appUrl, isolated.url));
    const deadline = Date.now() + 2000;
    while (arrivals < 16 && Date.now() < deadline)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(arrivals).toBe(16);
    const excess = attempt(id, ownerCookie, 'sessionId=overflow', config.appUrl, isolated.url);
    pending.push(excess);
    expect(await outcomeWithin(excess, 300)).toBe(429);
  } finally {
    release();
    await block;
    const results = await Promise.all(pending);
    for (const result of results)
      if (typeof result !== 'number') {
        result.terminate();
        await closed(result);
      }
    isolated.server.off('upgrade', observe);
    await runtime.order(id, () => {});
    const retry = await attempt(
      id,
      ownerCookie,
      'sessionId=after-pending',
      config.appUrl,
      isolated.url,
    );
    expect(retry).toBeInstanceOf(WebSocket);
    if (typeof retry !== 'number') {
      retry.terminate();
      await closed(retry);
    }
    await isolated.close();
  }
});
it('times out stalled upgrades and never upgrades their closed sockets after the gate resumes', async () => {
  const id = await newBoard(),
    isolated = await upgradeServer();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const block = runtime.order(id, () => {
    entered();
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await started;
  const work = attempt(id, ownerCookie, 'sessionId=stalled', config.appUrl, isolated.url);
  try {
    expect(await outcomeWithin(work, 6000)).toBe(408);
  } finally {
    release();
    await block;
    const result = await work;
    if (typeof result !== 'number') {
      result.terminate();
      await closed(result);
    }
    await runtime.order(id, () => {});
    await until(() => runtime.entry(id).connections.size === 0);
    await isolated.close();
  }
});
it('bounds unauthenticated IP handshake attempts before allocating auth or room work', async () => {
  const id = await newBoard(),
    isolated = await upgradeServer();
  try {
    for (let i = 0; i < 60; i++)
      expect(await attempt(id, '', 'sessionId=', config.appUrl, isolated.url)).toBe(422);
    expect(await attempt(id, '', 'sessionId=', config.appUrl, isolated.url)).toBe(429);
  } finally {
    await isolated.close();
  }
});

type NativeOptions = ConstructorParameters<
  typeof syncCore.TLSyncClient<TLRecord, Store<TLRecord, TLStoreProps>>
>[0];
type NativeSocket = NativeOptions['socket'];
type NativeMessage = Parameters<NativeSocket['sendMessage']>[0];
type NativeEvent = Parameters<Parameters<NativeSocket['onReceiveMessage']>[0]>[0];
interface LiveClient {
  store: Store<TLRecord, TLStoreProps>;
  wire: NativeEvent[];
  readonly loaded: boolean;
  close: () => void;
}
function nativeClient(id: string): LiveClient {
  const store = new Store<TLRecord, TLStoreProps>({
    schema: boardSchema,
    props: {
      defaultName: 'Synthetic SDK client',
      assets: {
        upload: async () => {
          throw new Error('No test uploads');
        },
        resolve: () => null,
        remove: async () => {},
      },
      users: {
        currentUser: atom<TLUser | null>('test-user', null),
        resolve: () => atom<TLUser | null>('test-resolved-user', null),
      },
      onMount: () => {},
    },
  });
  const wire: NativeEvent[] = [];
  const receivers = new Set<(value: NativeEvent) => void>(),
    statuses = new Set<(event: syncCore.TLSocketStatusChangeEvent) => void>();
  const ws = new WebSocket(
    `${base.replace('http:', 'ws:')}/api/board-access/${id}/sync?sessionId=${randomUUID()}&storeId=${randomUUID()}`,
    { headers: { Origin: config.appUrl, Cookie: ownerCookie } },
  );
  clients.add(ws);
  ws.on('error', () => {});
  const socket: NativeSocket = {
    connectionStatus: 'offline',
    restart: () => ws.terminate(),
    close: () => ws.terminate(),
    sendMessage: (message: NativeMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    },
    onReceiveMessage: (callback) => {
      receivers.add(callback);
      return () => {
        receivers.delete(callback);
      };
    },
    onStatusChange: (callback) => {
      statuses.add(callback);
      return () => {
        statuses.delete(callback);
      };
    },
  };
  ws.on('open', () => {
    socket.connectionStatus = 'online';
    for (const callback of statuses) callback({ status: 'online' });
  });
  ws.on('close', () => {
    socket.connectionStatus = 'offline';
    for (const callback of statuses) callback({ status: 'offline' });
  });
  ws.on('message', (value) => {
    const event = JSON.parse(value.toString()) as NativeEvent;
    wire.push(event);
    for (const callback of receivers) callback(event);
  });
  let loaded = false;
  const sync = new syncCore.TLSyncClient<TLRecord, typeof store>({
    store,
    socket,
    presence: atom<TLInstancePresence | null>('test-presence', null),
    onLoad: () => {
      loaded = true;
    },
    onSyncError: () => {},
  });
  const client = {
    store,
    wire,
    get loaded() {
      return loaded;
    },
    close: () => {
      sync.close();
      ws.terminate();
      store.dispose();
    },
  };
  liveClients.push(client);
  return client;
}
async function until(check: () => boolean) {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('SDK clients did not converge');
}
it('rebases actual TLSyncClient undo resurrection to the durable revision on both independent peers', async () => {
  const id = await newBoard(),
    a = nativeClient(id),
    b = nativeClient(id);
  await until(() => a.loaded && b.loaded);
  const original = {
    ...shape('python'),
    type: 'code-python',
    props: { w: 400, h: 280, source: 'print("copied")', version: 2 },
  } as TLRecord;
  const value = (client: typeof a, key = 'shape:python') =>
    client.store.get(key as never) as unknown as
      { props: { source: string; version: number } } | undefined;
  a.store.put([original]);
  await until(() => value(a)?.props.version === 2 && value(b)?.props.version === 2);
  a.store.put([{ ...original, id: 'shape:clone' } as TLRecord]);
  await until(() => value(b, 'shape:clone')?.props.source === 'print("copied")');
  a.store.remove(['shape:python' as never]);
  await until(() => !value(a) && !value(b));
  a.store.put([original]);
  await until(() => value(a)?.props.version === 3 && value(b)?.props.version === 3);
  expect(a.wire.flatMap((event) => (event.type === 'data' ? event.data : [event]))).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'push_result',
        action: expect.objectContaining({
          rebaseWithDiff: expect.objectContaining({
            'shape:python': expect.arrayContaining([
              expect.objectContaining({ props: expect.objectContaining({ version: 3 }) }),
            ]),
          }),
        }),
      }),
    ]),
  );
  const before = runtime.snapshot(id);
  await expect(runtime.updateCode(id, 'shape:python', 2, 'stale-ABA')).rejects.toMatchObject({
    status: 409,
  });
  expect(runtime.snapshot(id)).toEqual(before);
  a.store.remove(['shape:python' as never]);
  await until(() => !value(a) && !value(b));
  a.store.put([original]);
  await until(() => value(a)?.props.version === 4 && value(b)?.props.version === 4);
});

it('closes only its own sockets and preserves an unrelated upgrade handler and live connection', async () => {
  const unrelated = new WebSocketServer({ noServer: true });
  const handler = (
    req: import('node:http').IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ) => {
    if (req.url === '/unrelated-upgrade') unrelated.handleUpgrade(req, socket, head, () => {});
  };
  server.on('upgrade', handler);
  const other = new WebSocket(`${base.replace('http:', 'ws:')}/unrelated-upgrade`);
  clients.add(other);
  other.on('error', () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      other.once('open', resolve);
      other.once('error', reject);
    });
    const own = await open(await newBoard());
    await handshake(own);
    await sockets.close();
    await closed(own);
    expect(other.readyState).toBe(WebSocket.OPEN);
    expect(server.listeners('upgrade')).toContain(handler);
  } finally {
    other.terminate();
    await closed(other);
    server.off('upgrade', handler);
    for (const socket of unrelated.clients) socket.terminate();
    await new Promise<void>((resolve) => unrelated.close(() => resolve()));
  }
});

import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { atom } from '@tldraw/state';
import { Store } from '@tldraw/store';
import { TLSyncClient, type TLSocketStatusChangeEvent } from '@tldraw/sync-core';
import type { TLInstancePresence, TLRecord, TLStoreProps, TLUser } from '@tldraw/tlschema';
import { boardSchema } from '../shared/board-schema.js';
import { createDatabase, migrate, type Database } from '../server/db.js';
import { createApp } from '../server/app.js';
import type { Config } from '../server/config.js';
import { BoardRuntime } from '../server/boards/runtime.js';
import { attachBoardSockets } from '../server/boards/socket.js';
import type { BoardContext } from '../server/boards/http.js';

type Options = ConstructorParameters<
  typeof TLSyncClient<TLRecord, Store<TLRecord, TLStoreProps>>
>[0];
type SocketContract = Options['socket'];
type ClientEvent = Parameters<SocketContract['sendMessage']>[0];
type ServerEvent = Parameters<Parameters<SocketContract['onReceiveMessage']>[0]>[0];
type Push = Extract<ClientEvent, { type: 'push' }>;
const config: Config = {
  production: false,
  port: 0,
  appUrl: 'http://localhost:3196',
  secret: 'synthetic-ordering-only-secret-12345678901234567890',
  databaseSSL: false,
  dataDir: 'memory://',
  aiModel: 'unused',
  aiDailyLimit: 1,
};
let db: Database, runtime: BoardRuntime, server: Server, context: BoardContext;
let sockets: ReturnType<typeof attachBoardSockets>;
let directory: string, base: string, owner: string, cookie: string;
const clients: NativeClient[] = [];
const oldRAF = globalThis.requestAnimationFrame,
  oldCancelRAF = globalThis.cancelAnimationFrame;

async function until(check: () => boolean, label: string) {
  await expect.poll(check, { message: label, timeout: 5000, interval: 10 }).toBe(true);
}

/** Real TCP transport; only delivery timing is controlled, never protocol contents. */
class ControlledSocket implements SocketContract {
  connectionStatus: 'online' | 'offline' | 'error' = 'offline';
  readonly held: Push[] = [];
  readonly received: ServerEvent[] = [];
  holdPushes = false;
  restarts = 0;
  connections = 0;
  private ws?: WebSocket;
  private stopped = false;
  private manualOffline = false;
  private receivers = new Set<(value: ServerEvent) => void>();
  private statuses = new Set<(value: TLSocketStatusChangeEvent) => void>();
  constructor(private url: string) {
    this.connect();
  }
  private connect() {
    if (this.stopped || this.manualOffline) return;
    const ws = new WebSocket(this.url, { headers: { Origin: config.appUrl, Cookie: cookie } });
    this.ws = ws;
    ws.on('error', () => {});
    ws.on('open', () => {
      this.connections++;
      this.connectionStatus = 'online';
      this.statuses.forEach((fn) => fn({ status: 'online' }));
    });
    ws.on('close', () => {
      this.connectionStatus = 'offline';
      this.statuses.forEach((fn) => fn({ status: 'offline' }));
    });
    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as ServerEvent;
      this.received.push(event);
      this.receivers.forEach((fn) => fn(event));
    });
  }
  sendMessage(message: ClientEvent) {
    if (message.type === 'push' && message.diff) {
      if (this.holdPushes) {
        this.held.push(structuredClone(message));
        return;
      }
    }
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }
  replay(message: Push) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('Transport is offline');
    this.ws.send(JSON.stringify(message));
  }
  release() {
    const message = this.held.shift();
    if (!message) throw new Error('No native push was held');
    this.replay(message);
    return message;
  }
  async offline() {
    this.manualOffline = true;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    const closed = once(ws, 'close');
    ws.terminate();
    await closed;
  }
  online() {
    this.manualOffline = false;
    this.connect();
  }
  restart() {
    this.restarts++;
    void this.offline().then(() => {
      if (!this.stopped) this.online();
    });
  }
  close() {
    this.stopped = true;
    this.manualOffline = true;
    this.ws?.terminate();
  }
  onReceiveMessage = (fn: (value: ServerEvent) => void) => {
    this.receivers.add(fn);
    return () => {
      this.receivers.delete(fn);
    };
  };
  onStatusChange = (fn: (value: TLSocketStatusChangeEvent) => void) => {
    this.statuses.add(fn);
    return () => {
      this.statuses.delete(fn);
    };
  };
  events() {
    return this.received.flatMap((event) => (event.type === 'data' ? event.data : [event]));
  }
}
class NativeClient {
  readonly store = new Store<TLRecord, TLStoreProps>({
    schema: boardSchema,
    props: {
      defaultName: 'Synthetic ordering client',
      assets: {
        upload: async () => {
          throw new Error('No test uploads');
        },
        resolve: () => null,
        remove: async () => {},
      },
      users: {
        currentUser: atom<TLUser | null>('ordering-user', null),
        resolve: () => atom<TLUser | null>('ordering-resolved-user', null),
      },
      onMount: () => {},
    },
  });
  readonly socket: ControlledSocket;
  readonly sync: TLSyncClient<TLRecord, typeof this.store>;
  loaded = false;
  constructor(id: string) {
    this.socket = new ControlledSocket(
      `${base.replace('http:', 'ws:')}/api/board-access/${id}/sync?sessionId=${randomUUID()}&storeId=${randomUUID()}`,
    );
    this.sync = new TLSyncClient<TLRecord, typeof this.store>({
      store: this.store,
      socket: this.socket,
      presence: atom<TLInstancePresence | null>('ordering-presence', null),
      onLoad: () => {
        this.loaded = true;
      },
      onSyncError: () => {},
    });
    clients.push(this);
  }
  close() {
    this.sync.close();
    this.socket.close();
    this.store.dispose();
  }
  value(): TLRecord | undefined {
    return this.store.get('shape:shared' as never);
  }
  update(props: Record<string, string | number>) {
    const current = this.value();
    if (!current || current.typeName !== 'shape') throw new Error('Missing shared shape');
    this.store.put([{ ...current, props: { ...current.props, ...props } } as TLRecord]);
  }
}
function formula(): TLRecord {
  return {
    id: 'shape:shared',
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
    props: { w: 240, h: 100, source: 'base' },
  } as TLRecord;
}
async function pair() {
  const board = await context.boards.create(owner, {
    title: 'Synthetic ordering board',
    requestId: randomUUID(),
  });
  runtime.ensure(board.id);
  await context.boards.activate(owner, board.id);
  const a = new NativeClient(board.id),
    b = new NativeClient(board.id);
  await until(() => a.loaded && b.loaded, 'both actual SDK clients load');
  a.store.put([formula()]);
  await until(
    () =>
      !!a.value() && !!b.value() && a.socket.events().some((event) => event.type === 'push_result'),
    'common acknowledged baseline',
  );
  return { id: board.id, a, b };
}
function persisted(id: string) {
  return runtime
    .snapshot(id)
    .document.documents.map((entry) => entry.state)
    .find((record) => record.id === 'shape:shared');
}
async function reopen(id: string, expected: TLRecord | undefined) {
  const snapshot = runtime.snapshot(id);
  const states = snapshot.document.documents
    .map((entry) => entry.state)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const client of clients) {
    expect(
      Object.values(client.store.serialize('document')).sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(states);
  }
  for (const client of clients.splice(0)) client.close();
  await sockets.close();
  await runtime.close();
  runtime = await BoardRuntime.open(directory, { lockRetries: 0 });
  expect(runtime.snapshot(id)).toEqual(snapshot);
  expect(persisted(id)).toEqual(expected);
  // No live connection is reused across this explicit cold native-store reopen.
  context.runtime = runtime;
  sockets = attachBoardSockets(server, context);
}
beforeAll(async () => {
  globalThis.requestAnimationFrame = (fn) =>
    setTimeout(() => fn(performance.now()), 16) as unknown as number;
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  directory = await mkdtemp(join(tmpdir(), 'tutorflow-ordering-'));
  db = await createDatabase({ dataDir: 'memory://' });
  await migrate(db);
  runtime = await BoardRuntime.open(directory, { lockRetries: 0 });
  const app = createApp(db, config, undefined, runtime);
  context = app.boardContext;
  server = app.app.listen(0, '127.0.0.1');
  sockets = attachBoardSockets(server, context);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No synthetic port');
  base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { Origin: config.appUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Synthetic ordering owner',
      email: 'ordering@synthetic.test',
      password: 'OnlySyntheticOrdering123!',
    }),
  });
  expect(response.status).toBe(200);
  owner = ((await response.json()) as { user: { id: string } }).user.id;
  cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
});
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.restoreAllMocks();
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
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('converges same-field native edits in controlled arrival order and retains the accepted result on reopen', async () => {
  const { id, a, b } = await pair();
  a.socket.holdPushes = b.socket.holdPushes = true;
  a.update({ source: 'first participant' });
  b.update({ source: 'second participant' });
  await until(
    () => a.socket.held.length === 1 && b.socket.held.length === 1,
    'independent same-baseline native pushes',
  );
  a.socket.release();
  await until(
    () => (persisted(id) as { props?: { source?: string } })?.props?.source === 'first participant',
    'first native edit committed',
  );
  b.socket.release();
  const expected = {
    ...formula(),
    props: { w: 240, h: 100, source: 'second participant' },
  } as TLRecord;
  await until(
    () => isDeepStrictEqual(a.value(), expected) && isDeepStrictEqual(b.value(), expected),
    'both SDK stores converge to later accepted field value',
  );
  expect(persisted(id)).toEqual(expected);
  await reopen(id, expected);
});

it('preserves independent fields across a delayed push and recovers from a duplicate native ACK without another mutation', async () => {
  const { id, a, b } = await pair();
  a.socket.holdPushes = true;
  a.update({ source: 'delayed source' });
  await until(() => a.socket.held.length === 1, 'native push delayed before TCP send');
  b.update({ w: 360 });
  await until(
    () => (persisted(id) as { props?: { w?: number } })?.props?.w === 360,
    'independent peer resize commits first',
  );
  const delayed = a.socket.release();
  const expected = {
    ...formula(),
    props: { w: 360, h: 100, source: 'delayed source' },
  } as TLRecord;
  await until(
    () => isDeepStrictEqual(a.value(), expected) && isDeepStrictEqual(b.value(), expected),
    'delayed patch preserves peer resize',
  );
  const snapshot = runtime.snapshot(id);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const connections = a.socket.connections;
  a.socket.replay(delayed);
  await until(
    () => a.socket.restarts > 0 && a.socket.connections > connections,
    'actual SDK resets and reconnects after duplicate push_result',
  );
  await until(
    () =>
      a.socket.events().filter((event) => event.type === 'connect').length >= 2 &&
      isDeepStrictEqual(a.value(), expected),
    'duplicate recovery hydrates the actual client',
  );
  expect(errors.mock.calls).toEqual([
    [
      expect.objectContaining({
        message: 'Received push_result but there are no pending push requests',
      }),
    ],
  ]);
  expect(persisted(id)).toEqual(expected);
  expect(runtime.snapshot(id)).toEqual(snapshot);
  expect(b.value()).toEqual(expected);
  await reopen(id, expected);
});

it('drops an offline patch to an existing object deleted by the peer before actual SDK reconnect', async () => {
  const { id, a, b } = await pair();
  await a.socket.offline();
  a.update({ source: 'offline pending edit' });
  expect(a.value()).toMatchObject({ props: { source: 'offline pending edit' } });
  b.store.remove(['shape:shared' as never]);
  await until(
    () => !persisted(id) && !b.value(),
    'peer deletion is durably committed while editor is offline',
  );
  a.socket.online();
  await until(
    () => a.socket.events().filter((event) => event.type === 'connect').length >= 2 && !a.value(),
    'native tombstone hydration drops the stale existing-record patch',
  );
  expect(b.value()).toBeUndefined();
  expect(persisted(id)).toBeUndefined();
  // This is a patch, not an explicit put/undo resurrection; app draft recovery is tested separately.
  await reopen(id, undefined);
});

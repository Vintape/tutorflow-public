import { afterEach, beforeAll, afterAll, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { atom } from '@tldraw/state';
import { Store } from '@tldraw/store';
import { TLSyncClient, type TLSocketStatusChangeEvent } from '@tldraw/sync-core';
import type { TLRecord, TLInstancePresence, TLStoreProps, TLUser } from '@tldraw/tlschema';
import { boardSchema } from '../shared/board-schema.js';

const origin = 'http://localhost:3198';
// Derive the protocol types from the public constructor; 5.6.0 omits their names
// from the public declaration bundle while exposing this typed socket contract.
type ClientOptions = ConstructorParameters<typeof TLSyncClient<TLRecord, Store<TLRecord, TLStoreProps>>>[0];
type NativeSocketContract = ClientOptions['socket'];
type ClientEvent = Parameters<NativeSocketContract['sendMessage']>[0];
type ServerEvent = Parameters<Parameters<NativeSocketContract['onReceiveMessage']>[0]>[0];
let child: ChildProcess | undefined;
let directory: string | undefined;
const clients: NativeClient[] = [];
const oldRAF = globalThis.requestAnimationFrame;
const oldCancelRAF = globalThis.cancelAnimationFrame;
beforeAll(() => {
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterAll(() => { globalThis.requestAnimationFrame = oldRAF; globalThis.cancelAnimationFrame = oldCancelRAF; });
async function until(predicate: () => boolean, label: string, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await delay(10); }
  throw new Error(`Timed out: ${label}`);
}
async function terminate() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const timeout = setTimeout(() => child?.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timeout); }
}
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await terminate(); child = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
async function start() {
  let stderr = '';
  child = fork(resolve('tests/fixtures/board-server.ts'), [], {
    execArgv: ['--import', 'tsx'],
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8', NODE_ENV: 'development', TUTORFLOW_CRASH_TEST_DIR: directory },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  child.stderr?.on('data', (value: Buffer) => { stderr = (stderr + value.toString()).slice(-3000); });
  const timeout = setTimeout(() => child?.kill('SIGKILL'), 25000);
  try {
    return await new Promise<string>((done, fail) => {
      child!.once('message', (message: { ready?: boolean; port?: number }) => {
        if (message.ready && message.port) done(`http://127.0.0.1:${message.port}`);
        else fail(new Error('Unexpected crash fixture response'));
      });
      child!.once('exit', (code) => fail(new Error(`Crash fixture exited ${code}: ${stderr}`)));
      child!.once('error', fail);
    });
  } finally { clearTimeout(timeout); }
}
class NativeSocket implements NativeSocketContract {
  connectionStatus: 'online' | 'offline' | 'error' = 'offline';
  private messages = new Set<(message: ServerEvent) => void>();
  private statuses = new Set<(event: TLSocketStatusChangeEvent) => void>();
  private documentClocks = new Set<number>();
  readonly commits: number[] = [];
  readonly ws: WebSocket;
  constructor(url: string, cookie: string) {
    this.ws = new WebSocket(url, { headers: { Origin: origin, Cookie: cookie } });
    this.ws.on('open', () => { this.connectionStatus = 'online'; this.statuses.forEach((fn) => fn({ status: 'online' })); });
    this.ws.on('close', () => { this.connectionStatus = 'offline'; this.statuses.forEach((fn) => fn({ status: 'offline' })); });
    this.ws.on('error', () => {});
    this.ws.on('message', (value) => {
      const message = JSON.parse(value.toString()) as ServerEvent;
      for (const event of message.type === 'data' ? message.data : [message]) {
        if (event.type === 'push_result' && event.action === 'commit' && this.documentClocks.has(event.clientClock)) this.commits.push(event.serverClock);
      }
      this.messages.forEach((fn) => fn(message));
    });
  }
  sendMessage(message: ClientEvent) {
    if (message.type === 'push' && message.diff) this.documentClocks.add(message.clientClock);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }
  onReceiveMessage = (fn: (message: ServerEvent) => void) => { this.messages.add(fn); return () => { this.messages.delete(fn); }; };
  onStatusChange = (fn: (event: TLSocketStatusChangeEvent) => void) => { this.statuses.add(fn); return () => { this.statuses.delete(fn); }; };
  restart() { this.ws.terminate(); }
  close() { this.ws.terminate(); }
}
class NativeClient {
  readonly store = new Store({ schema: boardSchema, props: {
    defaultName: 'Synthetic board',
    assets: { upload: async () => { throw new Error('No fixture uploads'); }, resolve: () => null, remove: async () => {} },
    users: { currentUser: atom<TLUser | null>('fixture-user', null), resolve: () => atom<TLUser | null>('fixture-resolved-user', null) },
    onMount: () => {},
  } });
  readonly socket: NativeSocket;
  readonly sync: TLSyncClient<TLRecord, typeof this.store>;
  loaded = false;
  constructor(base: string, boardId: string, cookie: string) {
    this.socket = new NativeSocket(`${base.replace('http:', 'ws:')}/api/board-access/${boardId}/sync?sessionId=${randomUUID()}&storeId=${randomUUID()}`, cookie);
    this.sync = new TLSyncClient<TLRecord, typeof this.store>({ store: this.store, socket: this.socket,
      presence: atom<TLInstancePresence | null>('crash-presence', null),
      onLoad: () => { this.loaded = true; }, onSyncError: () => {} });
    clients.push(this);
  }
  close() { this.sync.close(); this.socket.close(); this.store.dispose(); }
}
function shape(id: string, source: string, index = 'a1'): TLRecord {
  return { id: `shape:${id}`, typeName: 'shape', type: 'math-formula', x: 0, y: 0, rotation: 0,
    index, parentId: 'page:page', isLocked: false, opacity: 1, meta: {}, props: { w: 240, h: 100, source } } as TLRecord;
}
it('retains two independently acknowledged concurrent documents and ACL metadata after SIGKILL', async () => {
  directory = await mkdtemp(join(tmpdir(), 'tutorflow-durable-'));
  let base = await start();
  const registration = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Synthetic durability tutor', email: `durable-${randomUUID()}@example.test`, password: 'Synthetic-crash-only-11223344' }),
  });
  expect(registration.status).toBe(200);
  const cookie = registration.headers.getSetCookie().map((v) => v.split(';')[0]).join('; ');
  const response = await fetch(`${base}/api/boards`, { method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Crash material', requestId: randomUUID() }) });
  expect(response.status).toBe(201);
  const board = await response.json() as { id: string };
  const a = new NativeClient(base, board.id, cookie), b = new NativeClient(base, board.id, cookie);
  await until(() => a.loaded && b.loaded, 'independent authenticated clients');
  a.store.put([shape('formula-a', 'x^2')]);
  b.store.put([shape('formula-b', 'y^2', 'a2')]);
  await until(() => a.socket.commits.length > 0 && b.socket.commits.length > 0 && a.store.has('shape:formula-b' as never) && b.store.has('shape:formula-a' as never), 'durable document ACKs received over TCP');
  const exited = once(child!, 'exit'); child!.kill('SIGKILL'); await exited;
  for (const client of clients.splice(0)) client.close();
  // Both private locks heartbeat for ten seconds. Wait for the confirmed-dead owner;
  // never bypass or remove a live lock to manufacture crash recovery.
  await delay(11000);
  base = await start();
  const reopened = new NativeClient(base, board.id, cookie);
  await until(() => reopened.loaded, 'fresh server/client after crash');
  expect(reopened.store.get('shape:formula-a' as never)).toMatchObject({ props: { source: 'x^2' } });
  expect(reopened.store.get('shape:formula-b' as never)).toMatchObject({ props: { source: 'y^2' } });
  const metadata = await fetch(`${base}/api/boards/${board.id}`, { headers: { Cookie: cookie } });
  expect(metadata.status).toBe(200);
}, 60000);

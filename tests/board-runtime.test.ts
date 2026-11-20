import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, writeFileSync, truncateSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLRecord } from '@tldraw/tlschema';
import { BoardRuntime } from '../server/boards/runtime.js';

let runtime: BoardRuntime | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'tutorflow-board-runtime-'));
  dirs.push(dir);
  runtime = await BoardRuntime.open(dir, { lockRetries: 0 });
  const id = randomUUID();
  runtime.ensure(id);
  return { dir, id, rt: runtime };
}
function formula(source = 'x^2'): TLRecord {
  return {
    id: 'shape:math',
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
  } as TLRecord;
}
function python(): TLRecord {
  return {
    ...formula(),
    id: 'shape:python',
    type: 'code-python',
    props: { w: 400, h: 280, source: '', version: 1 },
  } as TLRecord;
}
describe('native durable board runtime', () => {
  it('persists canonical source/schema across close and independent reopen', async () => {
    const { rt, id, dir } = await setup();
    await rt.run(id, (entry) => entry.room.updateStore((store) => store.put(formula())));
    const saved = rt.snapshot(id);
    expect(saved).toMatchObject({
      format: 'tutorflow-board',
      version: 1,
      engine: 'tldraw',
      engineVersion: '5.6.0',
      schemaVersion: 1,
    });
    expect(saved.document.schema).toBeDefined();
    await rt.close();
    runtime = await BoardRuntime.open(dir, { lockRetries: 0 });
    expect(runtime.snapshot(id)).toEqual(saved);
  });
  it('rejects final over-budget transaction without changing records or clock', async () => {
    const { rt, id } = await setup();
    await rt.run(id, (entry) => entry.room.updateStore((store) => store.put(formula())));
    const before = rt.snapshot(id);
    await expect(
      rt.run(id, (entry) =>
        entry.room.updateStore((store) => store.put(formula('x'.repeat(5000)))),
      ),
    ).rejects.toThrow();
    expect(rt.snapshot(id)).toEqual(before);
  });
  it('uses revision CAS for Python and refuses native source overwrite', async () => {
    const { rt, id } = await setup();
    await rt.run(id, (entry) => entry.room.updateStore((store) => store.put(python())));
    expect(await rt.updateCode(id, 'shape:python', 1, 'print(1)')).toEqual({ version: 2 });
    const before = rt.snapshot(id);
    await expect(rt.updateCode(id, 'shape:python', 1, 'print(2)')).rejects.toMatchObject({
      status: 409,
      code: 'CODE_CONFLICT',
    });
    await expect(
      rt.run(id, (entry) =>
        entry.room.updateStore((store) =>
          store.put({
            ...python(),
            props: { w: 400, h: 280, source: 'bypass', version: 3 },
          } as TLRecord),
        ),
      ),
    ).rejects.toThrow();
    expect(rt.snapshot(id)).toEqual(before);
    expect(await rt.updateCode(id, 'shape:python', 2, 'print(3)')).toEqual({ version: 3 });
  });
  it('copies immutable history to a new document and never silently creates a missing active document', async () => {
    const { rt, id } = await setup();
    await rt.run(id, (entry) => entry.room.updateStore((store) => store.put(formula('old'))));
    const version = rt.createVersion(id, 'Урок 1');
    await rt.run(id, (entry) => entry.room.updateStore((store) => store.put(formula('new'))));
    const copyId = randomUUID();
    rt.ensure(copyId, rt.version(id, version.id).document);
    const source = (boardId: string) =>
      (
        rt.snapshot(boardId).document.documents.find((d) => d.state.id === 'shape:math')!
          .state as unknown as { props: { source: string } }
      ).props.source;
    expect(source(copyId)).toBe('old');
    expect(source(id)).toBe('new');
    expect(rt.versions(id).map((v) => v.label)).toEqual(['Урок 1']);
    expect(() => rt.snapshot(randomUUID())).toThrow();
    expect(() => rt.ensure(randomUUID(), { ...rt.snapshot(id), version: 2 })).toThrow();
  });
  it('refuses traversal and a second active room authority', async () => {
    const { rt, dir } = await setup();
    expect(() => rt.ensure('../outside')).toThrow();
    await expect(BoardRuntime.open(dir, { lockRetries: 0 })).rejects.toThrow();
  });
  it('checks code authorization inside its queue before mutation', async () => {
    const { rt, id } = await setup();
    await rt.run(id, (entry) => entry.room.updateStore((store) => store.put(python())));
    const before = rt.snapshot(id);
    await expect(
      rt.updateCode(id, 'shape:python', 1, 'forbidden', async () => {
        throw new Error('revoked');
      }),
    ).rejects.toThrow('revoked');
    expect(rt.snapshot(id)).toEqual(before);
  });
  it('drains accepted work during close', async () => {
    const { rt, id, dir } = await setup();
    const write = rt.run(id, async (entry) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await entry.room.updateStore((store) => store.put(formula('before close')));
    });
    const close = rt.close();
    await write;
    await close;
    runtime = await BoardRuntime.open(dir, { lockRetries: 0 });
    expect(runtime.snapshot(id).document.documents.some((d) => d.state.id === 'shape:math')).toBe(
      true,
    );
  });
  it('orders metadata operations even if the canvas file is missing', async () => {
    const { rt } = await setup();
    const id = randomUUID();
    const seen: number[] = [];
    await Promise.all([
      rt.order(id, async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        seen.push(1);
      }),
      rt.order(id, () => {
        seen.push(2);
      }),
    ]);
    expect(seen).toEqual([1, 2]);
    expect(() => rt.snapshot(id)).toThrow();
  });
});

it('recovers the original copied seed after the second real SQLite seed insert fails', async () => {
  const { rt, id, dir } = await setup();
  await rt.run(id, (entry) =>
    entry.room.updateStore((store) => {
      store.put(formula('original-a'));
      store.put({ ...formula('original-b'), id: 'shape:second' } as TLRecord);
    }),
  );
  const seed = rt.snapshot(id),
    copy = randomUUID();
  const original = DatabaseSync.prototype.prepare;
  let inserts = 0;
  const fault = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const statement = original.call(this, sql);
    if (!/^INSERT OR REPLACE INTO documents/.test(sql)) return statement;
    return new Proxy(statement, {
      get(target, key) {
        if (key === 'run')
          return (...args: unknown[]) => {
            if (++inserts === 2) throw new Error('injected second seed write failure');
            return Reflect.apply(target.run, target, args);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  try {
    expect(() => rt.ensure(copy, seed)).toThrow('injected second seed write failure');
  } finally {
    fault.mockRestore();
  }
  const inspect = new DatabaseSync(join(dir, `${copy}.sqlite`));
  expect(inspect.prepare('SELECT initialized FROM tutorflow_lifecycle').get()).toMatchObject({
    initialized: 0,
  });
  const hasDocuments = inspect
    .prepare("SELECT name FROM sqlite_master WHERE name='documents'")
    .get();
  expect(
    hasDocuments
      ? (inspect.prepare('SELECT count(*) AS count FROM documents').get() as { count: number })
          .count
      : 0,
  ).toBe(0);
  inspect.close();
  expect(() => rt.entry(copy)).toThrow();
  // A retry must use the durable original intent even if its caller now has different data.
  await rt.run(id, (entry) =>
    entry.room.updateStore((store) => store.put(formula('changed-after-failure'))),
  );
  const changed = rt.snapshot(id);
  await rt.close();
  runtime = await BoardRuntime.open(dir, { lockRetries: 0 });
  runtime.ensure(copy, changed);
  const copied = runtime.snapshot(copy).document.documents.map((doc) => doc.state);
  expect(copied).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'shape:math',
        props: expect.objectContaining({ source: 'original-a' }),
      }),
      expect.objectContaining({
        id: 'shape:second',
        props: expect.objectContaining({ source: 'original-b' }),
      }),
    ]),
  );
  await runtime.close();
  runtime = await BoardRuntime.open(dir, { lockRetries: 0 });
  expect(runtime.snapshot(copy).document.documents.map((doc) => doc.state)).toEqual(copied);
});
it('fails closed for an existing empty file with no durable initialization intent', async () => {
  const { rt, dir, id } = await setup();
  const incomplete = randomUUID();
  const empty = new DatabaseSync(join(dir, `${incomplete}.sqlite`));
  empty.close();
  expect(() => rt.entry(incomplete)).toThrow();
  expect(() => rt.ensure(incomplete, rt.snapshot(id))).toThrow();
});
it('adopts a healthy legacy native file only after validating its schema and records', async () => {
  const { rt, id, dir } = await setup();
  await rt.run(id, (entry) =>
    entry.room.updateStore((store) => store.put(formula('legacy-material'))),
  );
  const saved = rt.snapshot(id);
  await rt.close();
  const sql = new DatabaseSync(join(dir, `${id}.sqlite`));
  sql.exec('DROP TABLE IF EXISTS tutorflow_lifecycle');
  sql.close();
  runtime = await BoardRuntime.open(dir, { lockRetries: 0 });
  expect(runtime.snapshot(id)).toEqual(saved);
  expect(
    runtime.entry(id).db.prepare('SELECT initialized,seed FROM tutorflow_lifecycle').get(),
  ).toMatchObject({ initialized: 1, seed: null });
});

it('duplicates populated Python objects and gives every resurrection a higher durable revision', async () => {
  const { rt, id, dir } = await setup();
  await rt.run(id, (entry) => entry.room.updateStore((store) => store.put(python())));
  await rt.updateCode(id, 'shape:python', 1, 'print("retained")');
  const record = rt.snapshot(id).document.documents.find((doc) => doc.state.id === 'shape:python')!
    .state as TLRecord;
  await rt.run(id, (entry) =>
    entry.room.updateStore((store) => store.put({ ...record, id: 'shape:duplicate' } as TLRecord)),
  );
  expect(
    rt.snapshot(id).document.documents.find((doc) => doc.state.id === 'shape:duplicate')!.state,
  ).toMatchObject({ props: { source: 'print("retained")', version: 2 } });
  await rt.run(id, (entry) => entry.room.updateStore((store) => store.delete('shape:python')));
  await rt.run(id, (entry) => entry.room.updateStore((store) => store.put(record)));
  expect(
    rt.snapshot(id).document.documents.find((doc) => doc.state.id === 'shape:python')!.state,
  ).toMatchObject({ props: { source: 'print("retained")', version: 3 } });
  const before = rt.snapshot(id);
  await expect(rt.updateCode(id, 'shape:python', 2, 'stale-ABA')).rejects.toMatchObject({
    status: 409,
  });
  expect(rt.snapshot(id)).toEqual(before);
  await rt.close();
  runtime = await BoardRuntime.open(dir, { lockRetries: 0 });
  await runtime.run(id, (entry) => entry.room.updateStore((store) => store.delete('shape:python')));
  await runtime.run(id, (entry) => entry.room.updateStore((store) => store.put(record)));
  expect(
    runtime.snapshot(id).document.documents.find((doc) => doc.state.id === 'shape:python')!.state,
  ).toMatchObject({ props: { version: 4, source: 'print("retained")' } });
  await expect(
    runtime.updateCode(id, 'shape:python', 3, 'stale-after-reopen'),
  ).rejects.toMatchObject({ status: 409 });
});
it('cancels the native deferred tombstone prune before closing its SQLite connection', async () => {
  const { rt, id } = await setup();
  await rt.run(id, (entry) => entry.room.updateStore((store) => store.put(formula())));
  vi.useFakeTimers();
  const output = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await rt.run(id, (entry) => entry.room.updateStore((store) => store.delete('shape:math')));
    await rt.close();
    await vi.advanceTimersByTimeAsync(1100);
    expect(output).not.toHaveBeenCalled();
  } finally {
    output.mockRestore();
    vi.useRealTimers();
  }
});

it('purges only explicitly deleted document files and preserves sibling boards', async () => {
  const { rt, id, dir } = await setup();
  await rt.run(id, (entry) =>
    entry.room.updateStore((store) => store.put(formula('keep-sibling'))),
  );
  const sibling = randomUUID();
  rt.ensure(sibling);
  const saved = rt.snapshot(id);
  rt.purge(sibling);
  rt.purge(sibling);
  expect(existsSync(join(dir, `${sibling}.sqlite`))).toBe(false);
  expect(existsSync(join(dir, `${sibling}.sqlite-wal`))).toBe(false);
  expect(rt.snapshot(id)).toEqual(saved);
  expect(() => rt.entry(sibling)).toThrow();
});
it('rejects a disk quota write before commit and caps the native SQLite file size', async () => {
  const { rt, id, dir } = await setup();
  const before = rt.snapshot(id),
    entry = rt.entry(id);
  const pageSize = (entry.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  const maxPages = (entry.db.prepare('PRAGMA max_page_count').get() as { max_page_count: number })
    .max_page_count;
  expect(pageSize * maxPages).toBe(96 * 1024 * 1024);
  const filler = join(dir, 'synthetic-quota.bin');
  writeFileSync(filler, '');
  truncateSync(filler, 1024 * 1024 * 1024);
  await expect(
    rt.run(id, (open) => open.room.updateStore((store) => store.put(formula('must-rollback')))),
  ).rejects.toMatchObject({ status: 507, code: 'BOARD_STORAGE_LIMIT' });
  expect(rt.snapshot(id)).toEqual(before);
  expect(() => rt.createVersion(id, 'must-not-save')).toThrow();
  expect(rt.versions(id)).toEqual([]);
  unlinkSync(filler);
  await rt.run(id, (open) =>
    open.room.updateStore((store) => store.put(formula('after-space-released'))),
  );
});

it('refuses the 201st document before allocating another SQLite file', async () => {
  const { rt, dir } = await setup();
  for (let i = 0; i < 199; i++) writeFileSync(join(dir, `${randomUUID()}.sqlite`), '');
  const overflow = randomUUID();
  expect(() => rt.ensure(overflow)).toThrowError(
    expect.objectContaining({ status: 507, code: 'BOARD_STORAGE_LIMIT' }),
  );
  expect(existsSync(join(dir, `${overflow}.sqlite`))).toBe(false);
});

import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import {
  TLSocketRoom,
  SQLiteSyncStorage,
  NodeSqliteWrapper,
  type RoomSnapshot,
  type TLSyncStorage,
} from '@tldraw/sync-core';
import type { TLRecord } from '@tldraw/tlschema';
import { boardSchema, validateBoardRecord } from '../../shared/board-schema.js';
import { canonicalBoardDocument } from '../../shared/board-fingerprint.js';
import { AppError } from '../errors.js';
import { BOARD_LIMITS, checkBoardRecords } from './limits.js';
import { assertBoardDiskBudget, BOARD_DISK_LIMITS, purgeBoardFiles } from './disk.js';

export interface BoardExport {
  format: 'tutorflow-board';
  version: 1;
  engine: 'tldraw';
  engineVersion: '5.6.0';
  schemaVersion: 1;
  document: RoomSnapshot;
}
interface Version {
  id: string;
  label: string;
  createdAt: string;
}
export interface OpenBoard {
  room: TLSocketRoom<TLRecord>;
  storage: SQLiteSyncStorage<TLRecord>;
  db: DatabaseSync;
  connections: Map<string, { kind: 'owner' | 'guest'; close: () => void }>;
  context: { codeWrite: boolean };
}
const envelope = z
  .object({
    format: z.literal('tutorflow-board'),
    version: z.literal(1),
    engine: z.literal('tldraw'),
    engineVersion: z.literal('5.6.0'),
    schemaVersion: z.literal(1),
    document: z
      .object({
        documents: z.array(
          z.object({
            state: z.record(z.string(), z.unknown()),
            lastChangedClock: z.number().int().nonnegative(),
          }),
        ),
        schema: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
  })
  .strict();
function code(record: unknown): { source: string; version: number } | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const r = record as {
    typeName?: string;
    type?: string;
    props?: { source: string; version: number };
  };
  return r.typeName === 'shape' && r.type === 'code-python' ? r.props : undefined;
}

function cancelPrune(storage: SQLiteSyncStorage<TLRecord>) {
  // Pinned 5.6.0 exposes this cancellable throttle at runtime (internal in declarations).
  (storage as unknown as { pruneTombstones: { cancel(): void } }).pruneTombstones.cancel();
}

/** One locked local authority, with native synchronous COMMIT before native ACK. */
export class BoardRuntime {
  private readonly entries = new Map<string, OpenBoard>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private closed = false;
  private stopping = false;
  private constructor(
    private readonly directory: string,
    private readonly release: () => Promise<void>,
  ) {}
  static async open(directory: string, options: { lockRetries?: number } = {}) {
    const path = resolve(directory);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(path, {
      stale: 10000,
      retries: {
        retries: options.lockRetries ?? 12,
        minTimeout: 1000,
        maxTimeout: 1000,
        randomize: false,
      },
    });
    return new BoardRuntime(path, release);
  }
  private path(id: string) {
    z.uuid().parse(id);
    if (this.closed) throw new AppError(503, 'Хранилище досок закрыто', 'BOARD_CLOSED');
    return join(this.directory, `${id}.sqlite`);
  }
  ensure(id: string, input?: unknown) {
    let snapshot: RoomSnapshot | undefined;
    if (input !== undefined) {
      const parsed = envelope.parse(input);
      // Native schema/record migrations validate this structural envelope on room open.
      snapshot = parsed.document as unknown as RoomSnapshot;
      checkBoardRecords(
        snapshot.documents.map((d) => d.state),
        validateBoardRecord,
      );
      // A copy is a fresh room, with no inherited transport clocks or tombstones.
      snapshot = {
        documents: snapshot.documents.map((d) => ({ state: d.state, lastChangedClock: 0 })),
        schema: snapshot.schema,
        clock: 0,
        documentClock: 0,
        tombstones: {},
        tombstoneHistoryStartsAtClock: 0,
      };
    }
    this.path(id);
    if (this.entries.has(id)) return;
    this.openEntry(id, snapshot, true);
  }
  entry(id: string): OpenBoard {
    this.path(id);
    const found = this.entries.get(id);
    if (found) return found;
    if (!existsSync(this.path(id)))
      throw new AppError(
        503,
        'Материал доски недоступен. Восстановите его из копии.',
        'BOARD_MISSING',
      );
    return this.openEntry(id);
  }
  private openEntry(id: string, snapshot?: RoomSnapshot, initialize = false): OpenBoard {
    if (this.entries.size >= BOARD_LIMITS.rooms) {
      const idle = [...this.entries].find(
        ([key, e]) => !e.connections.size && !this.queues.has(key),
      );
      if (!idle) throw new AppError(503, 'Все комнаты заняты. Повторите позже.', 'BOARD_CAPACITY');
      this.closeEntry(idle[0], idle[1]);
    }
    const existed = existsSync(this.path(id));
    assertBoardDiskBudget(this.directory, {
      newDocument: !existed,
      additionalBytes: !existed
        ? snapshot
          ? Buffer.byteLength(JSON.stringify(snapshot)) * 2
          : 64 * 1024
        : 0,
    });
    const db = new DatabaseSync(this.path(id));
    let storageToClose: SQLiteSyncStorage<TLRecord> | undefined;
    try {
      chmodSync(this.path(id), 0o600);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
      const pages = Math.floor(BOARD_DISK_LIMITS.sqliteBytes / pageSize);
      db.exec(`PRAGMA max_page_count=${pages}`);
      if (
        (db.prepare('PRAGMA max_page_count').get() as { max_page_count: number }).max_page_count >
        pages
      )
        throw new AppError(507, 'Файл доски превышает лимит хранилища', 'BOARD_STORAGE_LIMIT');
      const sql = new NodeSqliteWrapper(db);
      const incomplete = () =>
        new AppError(
          503,
          'Создание материала доски не завершено. Нужна проверка восстановления.',
          'BOARD_INCOMPLETE',
        );
      const createLifecycle = () =>
        db.exec(`CREATE TABLE IF NOT EXISTS tutorflow_lifecycle (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version=1),
        initialized INTEGER NOT NULL CHECK(initialized IN (0,1)), seed TEXT,
        CHECK((initialized=0 AND seed IS NOT NULL) OR (initialized=1 AND seed IS NULL)))`);
      const hasLifecycle = !!db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tutorflow_lifecycle'")
        .get();
      let lifecycle = hasLifecycle
        ? (db
            .prepare('SELECT version,initialized,seed FROM tutorflow_lifecycle WHERE singleton=1')
            .get() as { version: number; initialized: number; seed: string | null } | undefined)
        : undefined;
      if (hasLifecycle && (!lifecycle || lifecycle.version !== 1)) throw incomplete();
      if (!existed) {
        if (!initialize) throw incomplete();
        // Commit the exact intent first. A lost constructor COMMIT can then be retried
        // without consulting a source board that may already have changed.
        const seed =
          snapshot ??
          ({
            documentClock: 0,
            tombstoneHistoryStartsAtClock: 0,
            tombstones: {},
            schema: boardSchema.serialize(),
            documents: [
              {
                state: boardSchema.types.document.create({ id: 'document:document' }),
                lastChangedClock: 0,
              },
              {
                state: boardSchema.types.page.create({
                  id: 'page:page',
                  name: 'Page 1',
                  index: 'a1' as never,
                }),
                lastChangedClock: 0,
              },
            ],
          } as RoomSnapshot);
        const encoded = JSON.stringify(seed);
        sql.transaction(() => {
          createLifecycle();
          db.prepare(
            'INSERT INTO tutorflow_lifecycle (singleton,version,initialized,seed) VALUES (1,1,0,?)',
          ).run(encoded);
        });
        lifecycle = { version: 1, initialized: 0, seed: encoded };
      }
      let pending: RoomSnapshot | undefined;
      if (lifecycle?.initialized === 0) {
        if (!initialize || !lifecycle.seed) throw incomplete();
        pending = envelope.shape.document.parse(
          JSON.parse(lifecycle.seed),
        ) as unknown as RoomSnapshot;
        checkBoardRecords(
          pending.documents.map((doc) => doc.state),
          validateBoardRecord,
        );
      } else if (!SQLiteSyncStorage.hasBeenInitialized(sql)) {
        // In particular, never let the SDK replace an empty legacy/ACTIVE file
        // with its default document merely because its schema marker is missing.
        throw incomplete();
      }
      const native = sql.transaction(() => {
        // The pinned SDK constructor does not open an inner transaction.
        const storage = new SQLiteSyncStorage<TLRecord>({ sql, snapshot: pending });
        checkBoardRecords(
          [...storage.getSnapshot().documents, ...storage.getObjectsSnapshot()].map(
            (doc) => doc.state,
          ),
          validateBoardRecord,
        );
        createLifecycle();
        db.exec(
          'CREATE TABLE IF NOT EXISTS tutorflow_code_revisions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 1000000000), source TEXT NOT NULL, alive INTEGER NOT NULL CHECK(alive IN (0,1)))',
        );
        for (const doc of storage.getSnapshot().documents) {
          const value = code(doc.state);
          if (!value) continue;
          const prior = db
            .prepare('SELECT revision,source,alive FROM tutorflow_code_revisions WHERE id=?')
            .get(doc.state.id) as { revision: number; source: string; alive: number } | undefined;
          if (
            prior &&
            (prior.revision !== value.version || prior.source !== value.source || prior.alive !== 1)
          )
            throw new AppError(503, 'История версии кода повреждена', 'CODE_HISTORY');
          if (!prior)
            db.prepare(
              'INSERT INTO tutorflow_code_revisions (id,revision,source,alive) VALUES (?,?,?,1)',
            ).run(doc.state.id, value.version, value.source);
        }
        db.prepare(
          'INSERT INTO tutorflow_lifecycle (singleton,version,initialized,seed) VALUES (1,1,1,NULL) ON CONFLICT(singleton) DO UPDATE SET initialized=1,seed=NULL',
        ).run();
        return storage;
      });
      storageToClose = native;
      const context = { codeWrite: false };
      const getRevision = db.prepare(
        'SELECT revision,source,alive FROM tutorflow_code_revisions WHERE id=?',
      );
      const saveRevision = db.prepare(
        'INSERT INTO tutorflow_code_revisions (id,revision,source,alive) VALUES (?,?,?,1) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,source=excluded.source,alive=1',
      );
      const guarded: TLSyncStorage<TLRecord> = {
        transaction: (callback, options) => {
          let normalized = false;
          const outcome = native.transaction(
            (tx) => {
              const clockBefore = tx.getClock();
              const before = new Map([...tx.entries()].map(([key, value]) => [key, code(value)]));
              const result = callback(tx);
              let identities = (
                db.prepare('SELECT count(*) AS count FROM tutorflow_code_revisions').get() as {
                  count: number;
                }
              ).count;
              for (const [, record] of [...tx.entries()]) {
                const next = code(record);
                if (!next) continue;
                const previous = before.get(record.id);
                if (
                  !context.codeWrite &&
                  previous &&
                  (previous.source !== next.source || previous.version !== next.version)
                )
                  throw new AppError(409, 'Код изменяется через проверку версии', 'CODE_CONFLICT');
                const history = getRevision.get(record.id) as
                  { revision: number; source: string; alive: number } | undefined;
                let revision = next.version;
                if (!previous && history) {
                  revision = history.revision + 1;
                  if (revision !== next.version) {
                    tx.set(record.id, {
                      ...record,
                      props: {
                        ...(record as unknown as { props: object }).props,
                        version: revision,
                      },
                    } as TLRecord);
                    normalized = true;
                  }
                }
                if (!Number.isSafeInteger(revision) || revision < 1 || revision > 1e9)
                  throw new AppError(413, 'Достигнут лимит версий кода', 'CODE_REVISION_LIMIT');
                if (!history && ++identities > BOARD_LIMITS.records * 4)
                  throw new AppError(
                    413,
                    'Достигнут лимит истории объектов кода. Создайте копию доски.',
                    'CODE_HISTORY_LIMIT',
                  );
                if (
                  !history ||
                  history.revision !== revision ||
                  history.source !== next.source ||
                  history.alive !== 1
                )
                  saveRevision.run(record.id, revision, next.source);
              }
              for (const [key, previous] of before)
                if (previous && !code(tx.get(key)))
                  db.prepare('UPDATE tutorflow_code_revisions SET alive=0 WHERE id=?').run(key);
              checkBoardRecords(
                [...tx.entries()].map(([, record]) => record),
                validateBoardRecord,
              );
              if (tx.getClock() !== clockBefore) assertBoardDiskBudget(this.directory);
              return result;
            },
            { ...options, emitChanges: 'always' },
          );
          // The native room uses this actual committed diff to rebase the sender and
          // broadcast our monotonic resurrection revision to every peer.
          return {
            ...outcome,
            changes:
              options?.emitChanges === 'always' ||
              (normalized && options?.emitChanges === 'when-different')
                ? outcome.changes
                : undefined,
          };
        },
        getClock: () => native.getClock(),
        getSnapshot: () => native.getSnapshot(),
        getObjectsSnapshot: () => native.getObjectsSnapshot(),
        onChange: (callback) => native.onChange(callback),
      };
      const room = new TLSocketRoom<TLRecord>({ schema: boardSchema, storage: guarded });
      db.exec(
        'CREATE TABLE IF NOT EXISTS tutorflow_history (id TEXT PRIMARY KEY, label TEXT NOT NULL, createdAt TEXT NOT NULL, document TEXT NOT NULL)',
      );
      const entry: OpenBoard = { room, storage: native, db, context, connections: new Map() };
      this.entries.set(id, entry);
      return entry;
    } catch (error) {
      if (storageToClose) cancelPrune(storageToClose);
      db.close();
      throw error;
    }
  }
  run<T>(id: string, fn: (entry: OpenBoard) => T | Promise<T>): Promise<T> {
    return this.order(id, () => fn(this.entry(id)));
  }
  order<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
    if (this.stopping)
      return Promise.reject(new AppError(503, 'Хранилище досок закрывается', 'BOARD_CLOSED'));
    this.path(id);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(fn);
    this.queues.set(id, operation);
    void operation
      .finally(() => {
        if (this.queues.get(id) === operation) this.queues.delete(id);
      })
      .catch(() => {});
    return operation;
  }
  snapshot(id: string): BoardExport {
    return {
      format: 'tutorflow-board',
      version: 1,
      engine: 'tldraw',
      engineVersion: '5.6.0',
      schemaVersion: 1,
      document: this.entry(id).room.getCurrentSnapshot(),
    };
  }
  createVersion(id: string, label: string, request?: { id: string; fingerprint: string }): Version {
    z.string().trim().min(1).max(100).parse(label);
    const entry = this.entry(id);
    if (request) {
      const previous = entry.db
        .prepare('SELECT id,label,createdAt FROM tutorflow_history WHERE id=?')
        .get(request.id) as unknown as Version | undefined;
      if (previous) {
        if (previous.label !== label.trim())
          throw new AppError(
            409,
            'Этот запрос уже сохранил другую версию',
            'VERSION_REQUEST_CONFLICT',
          );
        return previous;
      }
    }
    const snapshot = this.snapshot(id);
    if (request) {
      const fingerprint = createHash('sha256')
        .update(
          canonicalBoardDocument(snapshot.document.documents.map((item) => item.state)),
          'utf8',
        )
        .digest('hex');
      if (fingerprint !== request.fingerprint)
        throw new AppError(
          409,
          'Доска изменилась. Проверьте её перед сохранением версии.',
          'STALE_BOARD',
        );
    }
    const document = JSON.stringify(snapshot);
    const budget = entry.db
      .prepare(
        'SELECT count(*) AS count, COALESCE(sum(length(CAST(document AS BLOB))),0) AS bytes FROM tutorflow_history',
      )
      .get() as { count: number; bytes: number };
    if (
      budget.count >= BOARD_LIMITS.snapshots ||
      budget.bytes + Buffer.byteLength(document) > BOARD_LIMITS.historyBytes
    )
      throw new AppError(
        413,
        'Достигнут лимит сохранённых версий. Экспортируйте материалы.',
        'BOARD_HISTORY_LIMIT',
      );
    assertBoardDiskBudget(this.directory, { additionalBytes: Buffer.byteLength(document) });
    const version = {
      id: request?.id ?? randomUUID(),
      label: label.trim(),
      createdAt: new Date().toISOString(),
    };
    entry.db
      .prepare('INSERT INTO tutorflow_history(id,label,createdAt,document) VALUES (?,?,?,?)')
      .run(version.id, version.label, version.createdAt, document);
    return version;
  }
  versions(id: string): Version[] {
    return this.entry(id)
      .db.prepare(
        'SELECT id,label,createdAt FROM tutorflow_history ORDER BY createdAt DESC,id DESC',
      )
      .all() as unknown as Version[];
  }
  version(id: string, versionId: string): Version & { document: BoardExport } {
    z.uuid().parse(versionId);
    const row = this.entry(id)
      .db.prepare('SELECT id,label,createdAt,document FROM tutorflow_history WHERE id=?')
      .get(versionId) as unknown as (Version & { document: string }) | undefined;
    if (!row) throw new AppError(404, 'Версия не найдена', 'NOT_FOUND');
    return { ...row, document: JSON.parse(row.document) as BoardExport };
  }
  updateCode(
    id: string,
    shapeId: string,
    expectedVersion: number,
    source: string,
    authorize?: () => Promise<void>,
  ) {
    z.string()
      .regex(/^shape:.{1,200}$/)
      .parse(shapeId);
    z.number().int().min(1).max(1e9).parse(expectedVersion);
    z.string().max(65536).parse(source);
    return this.run(id, async (entry) => {
      await authorize?.();
      entry.context.codeWrite = true;
      try {
        await entry.room.updateStore((store) => {
          const record = store.get(shapeId);
          const current = record && code(record);
          if (!record || !current) throw new AppError(404, 'Объект кода удалён', 'NOT_FOUND');
          if (current.version !== expectedVersion)
            throw new AppError(
              409,
              'Код уже изменён другим участником. Сравните версии.',
              'CODE_CONFLICT',
            );
          store.put({
            ...record,
            props: {
              ...(record as unknown as { props: object }).props,
              source,
              version: expectedVersion + 1,
            },
          } as TLRecord);
        });
        return { version: expectedVersion + 1 };
      } finally {
        entry.context.codeWrite = false;
      }
    });
  }
  closeGuests(id: string) {
    for (const connection of this.entries.get(id)?.connections.values() ?? [])
      if (connection.kind === 'guest') connection.close();
  }
  closeBoard(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    for (const connection of entry.connections.values()) connection.close();
  }
  /** Caller must hold order(id) and commit the metadata tombstone first. */
  purge(id: string) {
    this.path(id);
    const entry = this.entries.get(id);
    if (entry) {
      for (const connection of entry.connections.values()) connection.close();
      this.closeEntry(id, entry);
    }
    purgeBoardFiles(this.directory, id);
  }
  private closeEntry(id: string, entry: OpenBoard) {
    entry.room.close();
    cancelPrune(entry.storage);
    entry.db.close();
    this.entries.delete(id);
  }
  async close() {
    if (this.closed) return;
    this.stopping = true;
    await Promise.allSettled([...this.queues.values()]);
    this.closed = true;
    for (const [id, entry] of this.entries) {
      for (const connection of entry.connections.values()) connection.close();
      this.closeEntry(id, entry);
    }
    await this.release();
  }
}

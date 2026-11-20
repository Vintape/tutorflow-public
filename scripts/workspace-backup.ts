import { PGlite } from '@electric-sql/pglite';
import lockfile from 'proper-lockfile';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { toBoardStoreSnapshot, validateBoardRecord } from '../shared/board-schema.js';
import { canonicalBoardDocument } from '../shared/board-fingerprint.js';
import { checkBoardRecords } from '../server/boards/limits.js';

// Sources and archives are file-only inputs. All SQL below runs on a newly
// created private copy. No app configuration, SQL migration or runtime ensure().
const VERSIONS = { pglite: '0.5.15', tldraw: '5.6.0' };
const CALENDAR_OAUTH_MIGRATION = '0003_google_calendar.sql';
export const CALENDAR_TABLES_BY_MIGRATION = {
  [CALENDAR_OAUTH_MIGRATION]: ['google_calendar_connections', 'google_calendar_oauth_states'],
  '0004_google_calendar_sync.sql': ['google_calendar_sync'],
} as const;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const fail = (code: string) =>
  Object.assign(new Error(`Workspace backup refused (${code})`), { code });
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const safePath = z
  .string()
  .refine(
    (value) =>
      (value === 'crm' ||
        value.startsWith('crm/') ||
        value === 'boards' ||
        value.startsWith('boards/') ||
        value === 'auth-secret') &&
      value
        .split('/')
        .every((part) => part && part !== '.' && part !== '..' && !/[\\\0]/.test(part)),
  );
const entrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ path: safePath, kind: z.literal('directory') }),
  z.strictObject({
    path: safePath,
    kind: z.literal('file'),
    size: z.number().int().nonnegative().safe(),
    sha256: digest,
  }),
]);
const migrationSchema = z.strictObject({
  name: z.string().regex(/^\d+_[a-z0-9_]+\.sql$/),
  hash: digest,
});
const boardReferenceSchema = z.strictObject({
  id: z.uuid(),
  state: z.enum(['CREATING', 'ACTIVE', 'DELETED']),
  present: z.boolean(),
  initialized: z.boolean().nullable(),
  documentSha256: digest.nullable(),
  history: z.array(z.strictObject({ id: z.uuid(), sha256: digest })),
});
const catalogSchema = z.strictObject({
  metadataSha256: digest,
  boards: z.array(boardReferenceSchema),
});
const manifestSchema = z.strictObject({
  format: z.literal('tutorflow-workspace-cold'),
  version: z.literal(1),
  versions: z.strictObject({ pglite: z.string(), tldraw: z.string() }),
  migrations: z.array(migrationSchema).min(1),
  entries: z.array(entrySchema).min(2),
  catalog: catalogSchema,
});
type Entry = z.infer<typeof entrySchema>;
type Catalog = z.infer<typeof catalogSchema>;
type Migration = z.infer<typeof migrationSchema>;
type Manifest = z.infer<typeof manifestSchema>;
export interface WorkspaceSummary {
  active: number;
  creating: number;
  deleted: number;
  history: number;
}
export interface WorkspaceBackupResult {
  manifestSha256: string;
  summary: WorkspaceSummary;
}
export interface WorkspaceRestoreResult extends WorkspaceBackupResult {
  guestAccess: 'revoked';
  ownerSessions: 'cleared';
  migrations: Migration[];
}
const sorted = (entries: Entry[]) =>
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
function summary(catalog: Catalog): WorkspaceSummary {
  return {
    active: catalog.boards.filter((b) => b.state === 'ACTIVE').length,
    creating: catalog.boards.filter((b) => b.state === 'CREATING').length,
    deleted: catalog.boards.filter((b) => b.state === 'DELETED').length,
    history: catalog.boards.reduce((n, b) => n + b.history.length, 0),
  };
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false;
    throw error;
  }
}
async function directory(path: string) {
  if (!(await lstat(resolve(path))).isDirectory()) throw fail('EUNSAFE');
  return realpath(resolve(path));
}
const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
async function destinationPath(path: string, sources: string[]) {
  const target = join(await realpath(dirname(resolve(path))), basename(resolve(path)));
  if (sources.some((source) => overlaps(source, target))) throw fail('EUNSAFE');
  if (await exists(target)) throw fail('EEXIST');
  return target;
}
async function privateDirectory(path: string) {
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
}
async function file(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw fail('EUNSAFE');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function readText(path: string) {
  const handle = await file(path);
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}
async function fileDigest(path: string) {
  const handle = await file(path);
  try {
    const digest = createHash('sha256'),
      buffer = Buffer.alloc(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    return { size: (await handle.stat()).size, sha256: digest.digest('hex') };
  } finally {
    await handle.close();
  }
}
async function writePrivate(path: string, value: string) {
  const output = await open(path, 'wx', 0o600);
  try {
    await output.chmod(0o600);
    await output.writeFile(value);
    await output.sync();
  } finally {
    await output.close();
  }
}
async function copyFile(from: string, to: string) {
  const input = await file(from);
  try {
    const output = await open(to, 'wx', 0o600);
    try {
      await output.chmod(0o600);
      const buffer = Buffer.alloc(64 * 1024);
      while (true) {
        const { bytesRead } = await input.read(buffer);
        if (!bytesRead) break;
        for (let offset = 0; offset < bytesRead;)
          offset += (await output.write(buffer, offset, bytesRead - offset)).bytesWritten;
      }
      await output.sync();
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}
async function walk(root: string, prefix = '', archive = false): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const name of (await readdir(root)).sort()) {
    // These directory locks are owned by this verifier, acquired before walking.
    if (archive && ['manifest.json', 'manifest.sha256', 'crm.lock', 'boards.lock'].includes(name))
      continue;
    const path = prefix ? `${prefix}/${name}` : name,
      full = join(root, name),
      stat = await lstat(full);
    if (stat.isDirectory()) entries.push({ path, kind: 'directory' }, ...(await walk(full, path)));
    else if (stat.isFile()) entries.push({ path, kind: 'file', ...(await fileDigest(full)) });
    else throw fail('EUNSAFE');
  }
  return sorted(entries);
}
async function sourceEntries(crm: string, boards: string, secret?: string) {
  const entries: Entry[] = [
    { path: 'crm', kind: 'directory' },
    ...(await walk(crm, 'crm')),
    { path: 'boards', kind: 'directory' },
    ...(await walk(boards, 'boards')),
  ];
  if (secret) entries.push({ path: 'auth-secret', kind: 'file', ...(await fileDigest(secret)) });
  if (entries.some((entry) => !entrySchema.safeParse(entry).success)) throw fail('EUNSAFE');
  return sorted(entries);
}
async function copyEntries(
  entries: Entry[],
  destination: string,
  source: (path: string) => string,
) {
  for (const entry of entries) {
    const target = join(destination, entry.path);
    if (entry.kind === 'directory') await privateDirectory(target);
    else await copyFile(source(entry.path), target);
  }
}
async function locks<T>(paths: string[], work: (check: () => void) => Promise<T>): Promise<T> {
  const ordered = [...new Set(paths)].sort(),
    releases: (() => Promise<void>)[] = [];
  for (const path of ordered) if (await exists(`${path}.lock`)) throw fail('ELOCKED');
  let compromised = false;
  const check = () => {
    if (compromised) throw fail('ELOCKED');
  };
  try {
    for (const path of ordered)
      releases.push(
        await lockfile.lock(path, {
          retries: 0,
          stale: Number.MAX_SAFE_INTEGER,
          update: 1000,
          onCompromised: () => {
            compromised = true;
          },
        }),
      );
    const result = await work(check);
    check();
    return result;
  } finally {
    for (const release of releases.reverse())
      await release().catch((error: unknown) => {
        if (codeOf(error) !== 'ERELEASED') throw error;
      });
  }
}
async function cold(crm: string) {
  if (await exists(join(crm, 'postmaster.pid'))) throw fail('ENOTCOLD');
  if (
    !/^\d+\s*$/.test(await readText(join(crm, 'PG_VERSION'))) ||
    !(await exists(join(crm, 'global', 'pg_control')))
  )
    throw fail('EINTEGRITY');
}
async function installedVersion(name: string, anchor: string) {
  let path = dirname(createRequire(anchor).resolve(name));
  for (let depth = 0; depth < 6; depth++, path = dirname(path)) {
    try {
      const pkg = JSON.parse(await readText(join(path, 'package.json'))) as {
        name: string;
        version: string;
      };
      if (pkg.name === name) return pkg.version;
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error;
    }
  }
  throw fail('EVERSION');
}
async function versions(sourceProject?: string) {
  for (const anchor of [
    import.meta.url,
    ...(sourceProject ? [join(await directory(sourceProject), 'package.json')] : []),
  ]) {
    for (const [name, want] of [
      ['@electric-sql/pglite', VERSIONS.pglite],
      ['@tldraw/sync-core', VERSIONS.tldraw],
      ['@tldraw/tlschema', VERSIONS.tldraw],
      ['tldraw', VERSIONS.tldraw],
    ]) {
      if ((await installedVersion(name, anchor)) !== want) throw fail('EVERSION');
    }
  }
}
async function migrations(
  project = fileURLToPath(new URL('..', import.meta.url)),
): Promise<Migration[]> {
  const path = join(project, 'migrations');
  return Promise.all(
    (await readdir(path))
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map(async (name) =>
        migrationSchema.parse({ name, hash: hash(await readText(join(path, name))) }),
      ),
  );
}
function assertMigrationPrefix(applied: Migration[], allowed: Migration[]) {
  if (
    applied[1]?.name !== '0002_boards.sql' ||
    json(applied) !== json(allowed.slice(0, applied.length))
  )
    throw fail('EMIGRATIONS');
}
const boardEnvelope = z.strictObject({
  format: z.literal('tutorflow-board'),
  version: z.literal(1),
  engine: z.literal('tldraw'),
  engineVersion: z.literal('5.6.0'),
  schemaVersion: z.literal(1),
  document: z.unknown(),
});
function documentDigest(document: unknown) {
  return hash(canonicalBoardDocument(Object.values(toBoardStoreSnapshot(document).store)));
}
function sqliteBoard(path: string, state: 'ACTIVE' | 'CREATING') {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (
      Object.values(db.prepare('PRAGMA quick_check').get() ?? {})[0] !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw fail('EBOARD');
    const lifecycle = db
      .prepare('SELECT version,initialized,seed FROM tutorflow_lifecycle WHERE singleton=1')
      .get() as { version: number; initialized: number; seed: string | null } | undefined;
    if (!lifecycle || lifecycle.version !== 1 || ![0, 1].includes(lifecycle.initialized))
      throw fail('EBOARD');
    if (!lifecycle.initialized) {
      if (state !== 'CREATING' || !lifecycle.seed) throw fail('EBOARD');
      return {
        initialized: false,
        documentSha256: documentDigest(JSON.parse(lifecycle.seed)),
        history: [],
      };
    }
    if (lifecycle.seed !== null) throw fail('EBOARD');
    const metadata = db
      .prepare('SELECT migrationVersion,documentClock,schema FROM metadata')
      .all() as { migrationVersion: number; documentClock: number; schema: string }[];
    if (
      metadata.length !== 1 ||
      metadata[0].migrationVersion !== 3 ||
      !Number.isSafeInteger(metadata[0].documentClock) ||
      metadata[0].documentClock < 0
    )
      throw fail('EBOARD');
    function records(table: 'documents' | 'objects') {
      return db
        .prepare(`SELECT id,state,lastChangedClock FROM ${table} ORDER BY id`)
        .all()
        .map((row) => {
          const state = JSON.parse(
            typeof row.state === 'string'
              ? row.state
              : Buffer.from(row.state as Uint8Array).toString('utf8'),
          ) as {
            id: string;
            type: string;
            typeName: string;
            props?: { source: string; version: number };
          };
          if (
            state.id !== row.id ||
            !Number.isSafeInteger(row.lastChangedClock) ||
            Number(row.lastChangedClock) < 0 ||
            Number(row.lastChangedClock) > metadata[0].documentClock
          )
            throw fail('EBOARD');
          return { state, lastChangedClock: Number(row.lastChangedClock) };
        });
    }
    const documents = records('documents'),
      objects = records('objects'),
      all = [...documents, ...objects].map((row) => row.state);
    checkBoardRecords(all, validateBoardRecord);
    canonicalBoardDocument(all); // Also rejects cross-lane duplicate IDs.
    if (
      documents.filter((row) => row.state.typeName === 'document').length !== 1 ||
      !documents.some((row) => row.state.typeName === 'page')
    )
      throw fail('EBOARD');
    const documentSha256 = documentDigest({ documents, schema: JSON.parse(metadata[0].schema) });
    const ledger = db
      .prepare('SELECT id,revision,source,alive FROM tutorflow_code_revisions ORDER BY id')
      .all() as { id: string; revision: number; source: string; alive: number }[];
    for (const row of ledger) {
      const code = all.find((record) => record.id === row.id && record.type === 'code-python');
      if (
        !Number.isSafeInteger(row.revision) ||
        row.revision < 1 ||
        row.revision > 1e9 ||
        ![0, 1].includes(row.alive) ||
        (row.alive === 1
          ? !code || code.props?.version !== row.revision || code.props.source !== row.source
          : !!code)
      )
        throw fail('EBOARD');
    }
    if (
      all.some(
        (record) =>
          record.type === 'code-python' &&
          !ledger.some((row) => row.id === record.id && row.alive === 1),
      )
    )
      throw fail('EBOARD');
    const history = db
      .prepare('SELECT id,document FROM tutorflow_history ORDER BY id')
      .all()
      .map((row) => ({
        id: z.uuid().parse(row.id),
        sha256: documentDigest(boardEnvelope.parse(JSON.parse(String(row.document))).document),
      }));
    return { initialized: true, documentSha256, history };
  } finally {
    db.close();
  }
}
async function inspectCopy(root: string, allowedMigrations: Migration[]) {
  const db = new PGlite(join(root, 'crm'));
  try {
    await db.waitReady;
    await db.exec('BEGIN TRANSACTION READ ONLY');
    const applied = (await db.query<Migration>('SELECT name,hash FROM _migrations ORDER BY name'))
      .rows;
    assertMigrationPrefix(applied, allowedMigrations);
    const expectedCalendarTables = Object.entries(CALENDAR_TABLES_BY_MIGRATION)
      .flatMap(([migration, tables]) =>
        applied.some(({ name }) => name === migration) ? tables : [],
      )
      .sort();
    const actualCalendarTables = (
      await db.query<{ name: string }>(
        `SELECT tablename AS name FROM pg_tables
         WHERE schemaname=current_schema() AND tablename=ANY($1::text[])`,
        [Object.values(CALENDAR_TABLES_BY_MIGRATION).flat()],
      )
    ).rows
      .map(({ name }) => name)
      .sort();
    if (json(actualCalendarTables) !== json(expectedCalendarTables)) throw fail('EMIGRATIONS');
    const invalid = (
      await db.query<{ count: string }>(`SELECT (
      (SELECT count(*) FROM boards b LEFT JOIN "user" u ON u.id=b."ownerId" WHERE u.id IS NULL) +
      (SELECT count(*) FROM board_students x LEFT JOIN boards b ON b.id=x."boardId" AND b."ownerId"=x."ownerId" LEFT JOIN students s ON s.id=x."studentId" AND s."ownerId"=x."ownerId" WHERE b.id IS NULL OR s.id IS NULL) +
      (SELECT count(*) FROM board_lessons x LEFT JOIN boards b ON b.id=x."boardId" AND b."ownerId"=x."ownerId" LEFT JOIN lessons l ON l.id=x."lessonId" AND l."ownerId"=x."ownerId" WHERE b.id IS NULL OR l.id IS NULL) +
      (SELECT count(*) FROM board_invitations i LEFT JOIN boards b ON b.id=i."boardId" AND b."ownerId"=i."ownerId" WHERE b.id IS NULL OR (b.state='DELETED' AND i."revokedAt" IS NULL)) +
      (SELECT count(*) FROM board_guest_sessions s LEFT JOIN board_invitations i ON i.id=s."invitationId" AND i."ownerId"=s."ownerId" AND i."boardId"=s."boardId" AND i.role=s.role LEFT JOIN boards b ON b.id=s."boardId" AND b."ownerId"=s."ownerId" WHERE i.id IS NULL OR b.id IS NULL OR (b.state='DELETED' AND s."revokedAt" IS NULL))
    )::text AS count`)
    ).rows[0].count;
    if (invalid !== '0') throw fail('EREFERENCES');
    const metadata: Record<string, unknown> = {};
    for (const table of [
      'boards',
      'board_students',
      'board_lessons',
      'board_invitations',
      'board_guest_sessions',
    ])
      metadata[table] = (await db.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows;
    const rows = (
      await db.query<{ id: string; state: 'ACTIVE' | 'CREATING' | 'DELETED' }>(
        'SELECT id,state FROM boards ORDER BY id',
      )
    ).rows;
    const boards: Catalog['boards'] = [];
    for (const row of rows) {
      z.uuid().parse(row.id);
      const path = join(root, 'boards', `${row.id}.sqlite`),
        present = await exists(path);
      if (!present && row.state === 'ACTIVE') throw fail('EBOARD_MISSING');
      const checked =
        present && row.state !== 'DELETED'
          ? sqliteBoard(path, row.state)
          : { initialized: null, documentSha256: null, history: [] };
      boards.push(boardReferenceSchema.parse({ ...row, present, ...checked }));
    }
    for (const name of await readdir(join(root, 'boards'))) {
      const match = /^([0-9a-f-]{36})\.sqlite(?:-wal|-shm)?$/i.exec(name);
      if (match && !rows.some((row) => row.id === match[1])) throw fail('EREFERENCES');
    }
    const links = (
      await db.query<{ boardId: string; snapshotId: string | null }>(
        'SELECT "boardId","snapshotId" FROM board_lessons WHERE "snapshotId" IS NOT NULL',
      )
    ).rows;
    for (const link of links) {
      const board = boards.find((board) => board.id === link.boardId);
      if (board?.state === 'ACTIVE' && !board.history.some((entry) => entry.id === link.snapshotId))
        throw fail('EREFERENCES');
    }
    await db.exec('ROLLBACK');
    return {
      catalog: catalogSchema.parse({ metadataSha256: hash(json(metadata)), boards }),
      appliedMigrations: applied,
    };
  } catch (error) {
    if (['EMIGRATIONS', 'EREFERENCES', 'EBOARD_MISSING', 'EBOARD'].includes(codeOf(error) ?? ''))
      throw error;
    throw fail('EINTEGRITY');
  } finally {
    await db.close();
  }
}
async function validateInTemporaryCopy(
  source: string,
  entries: Entry[],
  allowedMigrations: Migration[],
  parent: string,
) {
  const temporary = await mkdtemp(join(parent, '.workspace-check-'));
  try {
    await chmod(temporary, 0o700);
    await copyEntries(entries, temporary, (path) => join(source, path));
    if (json(await walk(temporary)) !== json(entries)) throw fail('EINTEGRITY');
    return await inspectCopy(temporary, allowedMigrations);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function createWorkspaceBackup(options: {
  crmDir: string;
  boardDir: string;
  sourceProjectDir: string;
  destination: string;
  authSecretPath?: string;
}): Promise<WorkspaceBackupResult> {
  await versions(options.sourceProjectDir);
  const sourceMigrations = await migrations(options.sourceProjectDir);
  assertMigrationPrefix(sourceMigrations, await migrations());
  const crm = await directory(options.crmDir),
    boards = await directory(options.boardDir);
  if (overlaps(crm, boards)) throw fail('EUNSAFE');
  const destination = await destinationPath(options.destination, [crm, boards]);
  return locks([crm, boards], async (check) => {
    await cold(crm);
    const entries = await sourceEntries(crm, boards, options.authSecretPath);
    check();
    await privateDirectory(destination);
    try {
      await copyEntries(entries, destination, (path) =>
        path === 'auth-secret'
          ? options.authSecretPath!
          : path.startsWith('crm/')
            ? join(crm, path.slice(4))
            : join(boards, path.slice(7)),
      );
      if (json(await walk(destination)) !== json(entries)) throw fail('EINTEGRITY');
      const { catalog, appliedMigrations } = await validateInTemporaryCopy(
        destination,
        entries,
        sourceMigrations,
        dirname(destination),
      );
      await cold(crm);
      if (
        json(await sourceEntries(crm, boards, options.authSecretPath)) !== json(entries) ||
        json(await walk(destination)) !== json(entries)
      )
        throw fail('EINTEGRITY');
      check();
      const manifest: Manifest = {
        format: 'tutorflow-workspace-cold',
        version: 1,
        versions: VERSIONS,
        migrations: appliedMigrations,
        entries,
        catalog,
      };
      const raw = json(manifest),
        manifestSha256 = hash(raw);
      await writePrivate(join(destination, 'manifest.json'), raw);
      await writePrivate(join(destination, 'manifest.sha256'), `${manifestSha256}\n`);
      check();
      return { manifestSha256, summary: summary(catalog) };
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  });
}
async function readManifest(archive: string, expected: string): Promise<Manifest> {
  try {
    digest.parse(expected);
    const raw = await readText(join(archive, 'manifest.json'));
    if (
      hash(raw) !== expected ||
      (await readText(join(archive, 'manifest.sha256'))).trim() !== expected
    )
      throw fail('EINTEGRITY');
    const manifest = manifestSchema.parse(JSON.parse(raw));
    if (json(manifest.versions) !== json(VERSIONS)) throw fail('EVERSION');
    assertMigrationPrefix(manifest.migrations, await migrations());
    if (raw !== json(manifest) || json(await walk(archive, '', true)) !== json(manifest.entries))
      throw fail('EINTEGRITY');
    await cold(join(archive, 'crm'));
    return manifest;
  } catch (error) {
    if (['EVERSION', 'EMIGRATIONS'].includes(codeOf(error) ?? '')) throw error;
    throw fail('EINTEGRITY');
  }
}
async function revokeArchivedCredentialsOnCopy(root: string, migrations: Migration[]) {
  const db = new PGlite(join(root, 'crm'));
  try {
    await db.waitReady;
    await db.exec('BEGIN');
    try {
      await db.exec(
        'UPDATE board_invitations SET "revokedAt"=COALESCE("revokedAt",clock_timestamp())',
      );
      await db.exec(
        'UPDATE board_guest_sessions SET "revokedAt"=COALESCE("revokedAt",clock_timestamp())',
      );
      if (migrations.some(({ name }) => name === CALENDAR_OAUTH_MIGRATION)) {
        await db.exec('DELETE FROM google_calendar_oauth_states');
        await db.exec(
          `UPDATE google_calendar_connections
           SET "refreshCiphertext"=NULL,status='disconnected',"canReadBusy"=false,"calendarClaim"=NULL`,
        );
      }
      await db.exec('DELETE FROM session');
      await db.exec('COMMIT');
    } catch {
      await db.exec('ROLLBACK');
      throw fail('EFINALIZE');
    }
  } finally {
    await db.close();
  }
}
export async function verifyWorkspaceBackup(options: {
  archiveDir: string;
  destination: string;
  expectedManifestSha256: string;
}): Promise<WorkspaceRestoreResult> {
  await versions();
  const archive = await directory(options.archiveDir),
    destination = await destinationPath(options.destination, [archive]);
  const archiveCrm = await directory(join(archive, 'crm')),
    archiveBoards = await directory(join(archive, 'boards'));
  return locks([archive, archiveCrm, archiveBoards], async (check) => {
    const manifest = await readManifest(archive, options.expectedManifestSha256);
    check();
    await privateDirectory(destination);
    try {
      await copyEntries(manifest.entries, destination, (path) => join(archive, path));
      if (json(await walk(destination)) !== json(manifest.entries)) throw fail('EINTEGRITY');
      await readManifest(archive, options.expectedManifestSha256);
      check();
      const catalog = await locks(
        [join(destination, 'crm'), join(destination, 'boards')],
        async () => {
          const { catalog, appliedMigrations } = await inspectCopy(
            destination,
            manifest.migrations,
          );
          if (json(appliedMigrations) !== json(manifest.migrations)) throw fail('EMIGRATIONS');
          if (json(catalog) !== json(manifest.catalog)) throw fail('EREFERENCES');
          // A historical archive may precede a later revocation. Never resurrect
          // those bearer credentials when preparing a new copy for service.
          await revokeArchivedCredentialsOnCopy(destination, appliedMigrations);
          return catalog;
        },
      );
      check();
      return {
        manifestSha256: options.expectedManifestSha256,
        summary: summary(catalog),
        guestAccess: 'revoked',
        ownerSessions: 'cleared',
        migrations: manifest.migrations,
      };
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  });
}
async function main(args: string[]) {
  const [command, ...rest] = args,
    flags: Record<string, string> = {};
  const allowed =
    command === 'backup'
      ? ['--crm', '--boards', '--source-project', '--destination', '--auth-secret']
      : ['--archive', '--destination', '--manifest-sha256'];
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed.includes(rest[i]) || !rest[i + 1] || flags[rest[i]]) throw fail('EARGS');
    flags[rest[i]] = rest[i + 1];
  }
  if (!flags['--destination']) throw fail('EARGS');
  if (command === 'backup' && flags['--crm'] && flags['--boards'] && flags['--source-project']) {
    console.log(
      JSON.stringify({
        status: 'workspace-backup-created',
        ...(await createWorkspaceBackup({
          crmDir: flags['--crm'],
          boardDir: flags['--boards'],
          sourceProjectDir: flags['--source-project'],
          destination: flags['--destination'],
          authSecretPath: flags['--auth-secret'],
        })),
      }),
    );
  } else if (command === 'verify' && flags['--archive'] && flags['--manifest-sha256']) {
    const { manifestSha256, summary, guestAccess, ownerSessions } = await verifyWorkspaceBackup({
      archiveDir: flags['--archive'],
      destination: flags['--destination'],
      expectedManifestSha256: flags['--manifest-sha256'],
    });
    console.log(
      JSON.stringify({
        status: 'workspace-restore-verified',
        manifestSha256,
        summary,
        guestAccess,
        ownerSessions,
      }),
    );
  } else throw fail('EARGS');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const code = codeOf(error);
    console.error(
      JSON.stringify({
        status: 'refused',
        code: code && /^[A-Z_]+$/.test(code) ? code : 'EFAILED',
      }),
    );
    process.exitCode = 1;
  });
}

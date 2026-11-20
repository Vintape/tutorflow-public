import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import type { TLRecord } from '@tldraw/tlschema';
import { createDatabase, migrate } from '../server/db.js';
import { createAuth } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { TutorService } from '../server/service.js';
import { BoardService } from '../server/boards/service.js';
import { BoardRuntime } from '../server/boards/runtime.js';
import type { Config } from '../server/config.js';
import { createWorkspaceBackup, verifyWorkspaceBackup } from '../scripts/workspace-backup.js';

let root: string, base: string, owner: string, boardId: string, historyId: string, lessonId: string;
let pendingId: string,
  incompleteId: string,
  deletedId: string,
  guestToken: string,
  inviteToken: string;
const authSecret = 'synthetic-workspace-backup-secret-only-111111111111111';
const email = 'workspace-backup@tutorflow.test',
  password = 'SyntheticWorkspace112233!';
const config: Config = {
  production: false,
  port: 0,
  appUrl: 'http://localhost:3186',
  secret: authSecret,
  databaseSSL: false,
  dataDir: 'memory://',
  aiModel: 'disabled',
  aiDailyLimit: 1,
  boardsEnabled: true,
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function shape(type: 'math-formula' | 'code-python', source: string): TLRecord {
  return {
    id: `shape:${type}`,
    typeName: 'shape',
    type,
    x: 0,
    y: 0,
    rotation: 0,
    index: type === 'math-formula' ? 'a1' : 'a2',
    parentId: 'page:page',
    isLocked: false,
    opacity: 1,
    meta: {},
    props:
      type === 'math-formula' ? { w: 240, h: 100, source } : { w: 400, h: 280, source, version: 1 },
  } as TLRecord;
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tutorflow-workspace-backup-'));
  base = join(root, 'fixture');
  await mkdir(base);
  const db = await createDatabase({ dataDir: join(base, 'crm') });
  let openedRuntime: BoardRuntime | undefined;
  try {
    const runtime = await BoardRuntime.open(join(base, 'boards'), { lockRetries: 0 });
    openedRuntime = runtime;
    await migrate(db);
    owner = (
      await createAuth(db, config).api.signUpEmail({
        body: { name: 'Synthetic backup tutor', email, password },
      })
    ).user.id;
    const tutor = new TutorService(db),
      boards = new BoardService(db);
    const student = await tutor.createStudent(owner, {
      name: 'Synthetic student',
      subject: 'Math',
      level: '',
      price: 125000,
      duration: 60,
      goal: '',
      notes: 'Synthetic note',
    });
    lessonId = (
      await tutor.createLesson(owner, {
        studentId: student.id,
        startsAt: '2026-11-01T10:00:00Z',
        topic: 'Synthetic lesson',
        allowConflict: false,
      })
    ).id;
    boardId = (
      await boards.create(owner, { title: 'Synthetic workspace board', requestId: randomUUID() })
    ).id;
    runtime.ensure(boardId);
    await runtime.run(boardId, (entry) =>
      entry.room.updateStore((store) => {
        store.put(shape('math-formula', 'x^2'));
        store.put(shape('code-python', ''));
      }),
    );
    await runtime.updateCode(boardId, 'shape:code-python', 1, 'print("synthetic history")');
    historyId = runtime.createVersion(boardId, 'Synthetic saved lesson').id;
    await runtime.run(boardId, (entry) =>
      entry.room.updateStore((store) => store.put(shape('math-formula', 'x^3'))),
    );
    await runtime.updateCode(boardId, 'shape:code-python', 2, 'print("synthetic current")');
    await boards.activate(owner, boardId);
    await boards.link(owner, boardId, { studentId: student.id, lessonId, snapshotId: historyId });
    const invitation = await boards.createInvite(owner, boardId, {
      role: 'viewer',
      ttlMinutes: 60,
      maxUses: 2,
    });
    inviteToken = invitation.token;
    guestToken = (await boards.redeem(boardId, invitation.token)).token;
    pendingId = (
      await boards.create(owner, { title: 'Synthetic pending', requestId: randomUUID() })
    ).id;
    incompleteId = (
      await boards.create(owner, { title: 'Synthetic interrupted seed', requestId: randomUUID() })
    ).id;
    const incomplete = new DatabaseSync(join(base, 'boards', `${incompleteId}.sqlite`));
    try {
      incomplete.exec(
        'CREATE TABLE tutorflow_lifecycle(singleton INTEGER PRIMARY KEY, version INTEGER, initialized INTEGER, seed TEXT)',
      );
      incomplete
        .prepare('INSERT INTO tutorflow_lifecycle VALUES(1,1,0,?)')
        .run(JSON.stringify(runtime.snapshot(boardId).document));
    } finally {
      incomplete.close();
    }
    deletedId = (
      await boards.create(owner, { title: 'Synthetic deleted', requestId: randomUUID() })
    ).id;
    runtime.ensure(deletedId);
    await boards.activate(owner, deletedId);
    await boards.remove(owner, deletedId);
    runtime.purge(deletedId);
  } finally {
    try {
      await openedRuntime?.close();
    } finally {
      await db.close();
    }
  }
  await writeFile(join(base, 'auth-secret'), authSecret, { mode: 0o600 });
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
async function absent(path: string) {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}
async function denied(action: Promise<unknown>) {
  const accepted = await action.then(
    () => true,
    (error: unknown) => {
      expect(error).toMatchObject({ status: 404 });
      return false;
    },
  );
  expect(accepted).toBe(false);
}
async function fixture(label: string) {
  const path = join(root, label);
  await cp(base, path, { recursive: true });
  return path;
}
function backupOptions(source: string, destination: string, secret = true) {
  return {
    crmDir: join(source, 'crm'),
    boardDir: join(source, 'boards'),
    sourceProjectDir: process.cwd(),
    destination,
    ...(secret ? { authSecretPath: join(source, 'auth-secret') } : {}),
  };
}
async function fingerprint(root: string): Promise<string> {
  const entries: string[] = [];
  async function visit(path: string, prefix = '') {
    for (const name of (await readdir(path)).sort()) {
      const full = join(path, name),
        stat = await lstat(full),
        key = `${prefix}${name}`;
      if (stat.isDirectory()) {
        entries.push(`${key}/`);
        await visit(full, `${key}/`);
      } else if (stat.isFile()) entries.push(`${key}:${hash(await readFile(full))}`);
      else entries.push(`${key}:unsafe`);
    }
  }
  await visit(root);
  return hash(entries.join('\n'));
}

it('recovers CRM, native source, history, lesson links and guest ACL in a fresh server after synthetic source loss', async () => {
  const source = await fixture('roundtrip'),
    archive = join(root, 'roundtrip-archive');
  const original = await fingerprint(source);
  const result = await createWorkspaceBackup(backupOptions(source, archive));
  expect(await fingerprint(source)).toBe(original);
  const manifest = await readFile(join(archive, 'manifest.json'), 'utf8');
  expect(manifest).not.toContain(authSecret);
  expect(manifest).not.toContain(guestToken);
  expect(manifest).not.toContain(inviteToken);
  expect(manifest).not.toContain('print("synthetic current")');
  expect(result.summary).toMatchObject({ active: 1, creating: 2, deleted: 1, history: 1 });
  expect((await lstat(archive)).mode & 0o777).toBe(0o700);
  expect((await lstat(join(archive, 'auth-secret'))).mode & 0o777).toBe(0o600);
  const archived = await fingerprint(archive);
  await rm(source, { recursive: true }); // Synthetic-only simulated loss; original user data is never used.
  const restored = join(root, 'roundtrip-restore');
  const report = await verifyWorkspaceBackup({
    archiveDir: archive,
    destination: restored,
    expectedManifestSha256: result.manifestSha256,
  });
  expect(report.summary).toEqual(result.summary);
  expect(await fingerprint(archive)).toBe(archived);
  const db = await createDatabase({ dataDir: join(restored, 'crm') });
  let openedRuntime: BoardRuntime | undefined, openedServer: Server | undefined;
  try {
    const runtime = await BoardRuntime.open(join(restored, 'boards'), { lockRetries: 0 });
    openedRuntime = runtime;
    const server = createApp(
      db,
      { ...config, secret: await readFile(join(restored, 'auth-secret'), 'utf8') },
      undefined,
      runtime,
    ).app.listen(0, '127.0.0.1');
    openedServer = server;
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Synthetic server has no port');
    const url = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${url}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { Origin: config.appUrl, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const response = await fetch(`${url}/api/boards/${boardId}/export`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as {
      document: {
        documents: { state: { id: string; props: { source: string; version?: number } } }[];
      };
    };
    expect(
      snapshot.document.documents.find((row) => row.state.id === 'shape:math-formula')?.state.props
        .source,
    ).toBe('x^3');
    expect(
      snapshot.document.documents.find((row) => row.state.id === 'shape:code-python')?.state.props,
    ).toMatchObject({ source: 'print("synthetic current")', version: 3 });
    const links = await fetch(`${url}/api/boards/${boardId}/links`, {
      headers: { Cookie: cookie },
    });
    expect(await links.json()).toMatchObject({ lessons: [{ lessonId, snapshotId: historyId }] });
    const saved = runtime.version(boardId, historyId).document.document.documents;
    expect(saved.find((row) => row.state.id === 'shape:math-formula')?.state).toMatchObject({
      props: { source: 'x^2' },
    });
    await denied(new BoardService(db).authorizeGuest(boardId, guestToken));
    await denied(new BoardService(db).redeem(boardId, inviteToken));
    expect(
      (await db.query<{ state: string }>('SELECT state FROM boards WHERE id=$1', [pendingId]))[0]
        .state,
    ).toBe('CREATING');
    expect(
      (await db.query<{ state: string }>('SELECT state FROM boards WHERE id=$1', [incompleteId]))[0]
        .state,
    ).toBe('CREATING');
    expect(
      (await db.query<{ state: string }>('SELECT state FROM boards WHERE id=$1', [deletedId]))[0]
        .state,
    ).toBe('DELETED');
    await absent(join(restored, 'boards', `${pendingId}.sqlite`));
    await absent(join(restored, 'boards', `${deletedId}.sqlite`));
  } finally {
    try {
      if (openedServer)
        await new Promise<void>((done) => {
          openedServer!.close(() => done());
          openedServer!.closeAllConnections();
        });
    } finally {
      try {
        await openedRuntime?.close();
      } finally {
        await db.close();
      }
    }
  }
});

it.each(['crm', 'boards'] as const)(
  'refuses a live %s authority and leaves sources and output intact',
  async (which) => {
    const source = await fixture(`live-${which}`),
      destination = join(root, `live-${which}-archive`);
    const authority =
      which === 'crm'
        ? await createDatabase({ dataDir: join(source, 'crm') })
        : await BoardRuntime.open(join(source, 'boards'), { lockRetries: 0 });
    try {
      const before = await fingerprint(source);
      await expect(createWorkspaceBackup(backupOptions(source, destination))).rejects.toMatchObject(
        { code: 'ELOCKED' },
      );
      expect(await fingerprint(source)).toBe(before);
      await absent(destination);
    } finally {
      await authority.close();
    }
    await absent(`${join(source, 'crm')}.lock`);
    await absent(`${join(source, 'boards')}.lock`);
  },
);
it('refuses a stale board lock without force-unlocking it', async () => {
  const source = await fixture('stale'),
    lock = `${join(source, 'boards')}.lock`;
  await mkdir(lock);
  await utimes(lock, new Date(0), new Date(0));
  await expect(
    createWorkspaceBackup(backupOptions(source, join(root, 'stale-archive'))),
  ).rejects.toMatchObject({ code: 'ELOCKED' });
  expect((await lstat(lock)).mtimeMs).toBe(0);
  await rm(lock, { recursive: true });
  await absent(`${join(source, 'crm')}.lock`);
});
it('captures the exact cold file set, including WAL/SHM and recovery side files, without opening originals', async () => {
  const source = await fixture('sidecars');
  // These belong to a DELETED document and stay opaque/inaccessible; no SQLite is opened for it.
  for (const suffix of ['-wal', '-shm', '.intent', '.ledger'])
    await writeFile(
      join(source, 'boards', `${deletedId}.sqlite${suffix}`),
      `synthetic cold ${suffix}`,
    );
  const before = await fingerprint(source),
    archive = join(root, 'sidecars-archive');
  await createWorkspaceBackup(backupOptions(source, archive, false));
  expect(await fingerprint(source)).toBe(before);
  for (const suffix of ['-wal', '-shm', '.intent', '.ledger'])
    expect(await readFile(join(archive, 'boards', `${deletedId}.sqlite${suffix}`), 'utf8')).toBe(
      `synthetic cold ${suffix}`,
    );
  await absent(join(archive, 'auth-secret'));
});
it.each(['header', 'board', 'partial'] as const)(
  'rejects %s corruption before creating a restore',
  async (kind) => {
    const source = await fixture(`corrupt-${kind}`),
      archive = join(root, `corrupt-${kind}-archive`);
    const result = await createWorkspaceBackup(backupOptions(source, archive));
    if (kind === 'header') await writeFile(join(archive, 'manifest.json'), '{}\n');
    if (kind === 'board')
      await writeFile(join(archive, 'boards', `${boardId}.sqlite`), 'synthetic damage');
    if (kind === 'partial') await rm(join(archive, 'crm', 'PG_VERSION'));
    const destination = join(root, `corrupt-${kind}-restore`);
    await expect(
      verifyWorkspaceBackup({
        archiveDir: archive,
        destination,
        expectedManifestSha256: result.manifestSha256,
      }),
    ).rejects.toMatchObject({ code: 'EINTEGRITY' });
    await absent(destination);
  },
);
it('refuses an intactly hashed archive missing an ACTIVE database instead of creating an empty board', async () => {
  const source = await fixture('missing-active'),
    archive = join(root, 'missing-active-archive');
  await createWorkspaceBackup(backupOptions(source, archive));
  await rm(join(archive, 'boards', `${boardId}.sqlite`));
  const manifest = JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8')) as {
    entries: { path: string }[];
  };
  manifest.entries = manifest.entries.filter((entry) => entry.path !== `boards/${boardId}.sqlite`);
  const raw = `${JSON.stringify(manifest, null, 2)}\n`,
    expectedManifestSha256 = hash(raw);
  await writeFile(join(archive, 'manifest.json'), raw);
  await writeFile(join(archive, 'manifest.sha256'), `${expectedManifestSha256}\n`);
  const destination = join(root, 'missing-active-restore');
  await expect(
    verifyWorkspaceBackup({ archiveDir: archive, destination, expectedManifestSha256 }),
  ).rejects.toMatchObject({ code: 'EBOARD_MISSING' });
  await absent(destination);
});
it.each(['pglite', 'tldraw'] as const)(
  'pins %s and never overwrites an output',
  async (version) => {
    const source = await fixture(`versions-${version}`),
      archive = join(root, `versions-${version}-archive`);
    const result = await createWorkspaceBackup(backupOptions(source, archive));
    const before = await fingerprint(archive);
    await expect(createWorkspaceBackup(backupOptions(source, archive))).rejects.toMatchObject({
      code: 'EEXIST',
    });
    const destination = join(root, `existing-output-${version}`);
    await mkdir(destination);
    await writeFile(join(destination, 'keep'), 'synthetic keep');
    await expect(
      verifyWorkspaceBackup({
        archiveDir: archive,
        destination,
        expectedManifestSha256: result.manifestSha256,
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(destination, 'keep'), 'utf8')).toBe('synthetic keep');
    expect(await fingerprint(archive)).toBe(before);
    const manifest = JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8')) as {
      versions: { pglite: string; tldraw: string };
    };
    manifest.versions[version] = '99.0.0';
    const raw = `${JSON.stringify(manifest, null, 2)}\n`,
      digest = hash(raw);
    await writeFile(join(archive, 'manifest.json'), raw);
    await writeFile(join(archive, 'manifest.sha256'), `${digest}\n`);
    await expect(
      verifyWorkspaceBackup({
        archiveDir: archive,
        destination: join(root, `future-version-${version}`),
        expectedManifestSha256: digest,
      }),
    ).rejects.toMatchObject({ code: 'EVERSION' });
  },
);
it('refuses unsafe source entries and cannot follow a secret symlink', async () => {
  const source = await fixture('unsafe');
  await symlink(join(source, 'auth-secret'), join(source, 'boards', 'escape'));
  await expect(
    createWorkspaceBackup(backupOptions(source, join(root, 'unsafe-archive'))),
  ).rejects.toMatchObject({ code: 'EUNSAFE' });
  await absent(join(root, 'unsafe-archive'));
  expect(await readFile(join(source, 'auth-secret'), 'utf8')).toBe(authSecret);
});
it('rejects broken applied migrations without modifying the cold sources', async () => {
  const source = await fixture('bad-migrations'),
    db = await createDatabase({ dataDir: join(source, 'crm') });
  try {
    await db.query('UPDATE _migrations SET hash=$1 WHERE name=$2', [
      '0'.repeat(64),
      '0002_boards.sql',
    ]);
  } finally {
    await db.close();
  }
  const before = await fingerprint(source);
  await expect(
    createWorkspaceBackup(backupOptions(source, join(root, 'bad-migrations-archive'))),
  ).rejects.toMatchObject({ code: 'EMIGRATIONS' });
  expect(await fingerprint(source)).toBe(before);
  await absent(join(root, 'bad-migrations-archive'));
});

it('restores the pre-Calendar migration prefix without applying later migrations', async () => {
  const source = await fixture('pre-calendar'),
    archive = join(root, 'pre-calendar-archive'),
    destination = join(root, 'pre-calendar-restore');
  const oldCrm = await createDatabase({ dataDir: join(source, 'crm') });
  try {
    await oldCrm.query('DROP TABLE IF EXISTS google_calendar_sync');
    await oldCrm.query('DROP TABLE google_calendar_oauth_states, google_calendar_connections');
    await oldCrm.query("DELETE FROM _migrations WHERE name >= '0003'");
  } finally {
    await oldCrm.close();
  }
  const before = await fingerprint(source);
  const { manifestSha256 } = await createWorkspaceBackup(backupOptions(source, archive));
  const archived = await fingerprint(archive);
  await verifyWorkspaceBackup({
    archiveDir: archive,
    destination,
    expectedManifestSha256: manifestSha256,
  });
  expect(await fingerprint(source)).toBe(before);
  expect(await fingerprint(archive)).toBe(archived);
  const db = await createDatabase({ dataDir: join(destination, 'crm') });
  try {
    expect(await db.query('SELECT name FROM _migrations ORDER BY name')).toEqual([
      { name: '0001_initial.sql' },
      { name: '0002_boards.sql' },
    ]);
    expect(
      await db.query("SELECT tablename FROM pg_tables WHERE tablename LIKE 'google_calendar_%'"),
    ).toEqual([]);
    expect(await db.query('SELECT id FROM lessons WHERE id=$1', [lessonId])).toEqual([
      { id: lessonId },
    ]);
  } finally {
    await db.close();
  }
});

it('refuses an intact manifest with a gap in its applied migration names', async () => {
  const source = await fixture('migration-gap'),
    archive = join(root, 'migration-gap-archive'),
    destination = join(root, 'migration-gap-restore');
  await createWorkspaceBackup(backupOptions(source, archive));
  const manifest = JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8')) as {
    migrations: { name: string }[];
  };
  manifest.migrations = manifest.migrations.filter(({ name }) => name !== '0002_boards.sql');
  const raw = `${JSON.stringify(manifest, null, 2)}\n`,
    expectedManifestSha256 = hash(raw);
  await writeFile(join(archive, 'manifest.json'), raw);
  await writeFile(join(archive, 'manifest.sha256'), `${expectedManifestSha256}\n`);
  await expect(
    verifyWorkspaceBackup({ archiveDir: archive, destination, expectedManifestSha256 }),
  ).rejects.toMatchObject({ code: 'EMIGRATIONS' });
  await absent(destination);
});

it('disconnects Calendar OAuth on the restored copy while keeping its destination and pending job', async () => {
  const source = await fixture('calendar-credentials'),
    archive = join(root, 'calendar-credentials-archive'),
    destination = join(root, 'calendar-credentials-restore');
  const original = await createDatabase({ dataDir: join(source, 'crm') });
  try {
    await original.query(
      `INSERT INTO google_calendar_connections
      ("ownerId",id,"googleSubject","refreshCiphertext","calendarId",status,"canReadBusy","calendarClaim")
      VALUES ($1,'test-connection','test-google-subject','synthetic-encrypted-refresh','test-calendar','connected',true,'synthetic-claim')`,
      [owner],
    );
    await original.query(
      `INSERT INTO google_calendar_oauth_states
      ("ownerId","sessionId","stateHash","codeVerifier",nonce,"expiresAt")
      SELECT $1,id,'synthetic-state-hash','synthetic-verifier','synthetic-nonce',now()+interval '1 minute'
      FROM session WHERE "userId"=$1 LIMIT 1`,
      [owner],
    );
    await original.query(
      `INSERT INTO google_calendar_sync
      ("ownerId","connectionId","lessonId",generation,"eventId","desiredAction","desiredVersion",
        "startsAt",duration,"appliedVersion",etag)
      SELECT "ownerId",'test-connection',id,1,'testevent','upsert',2,"startsAt",duration,1,'test-etag'
      FROM lessons WHERE id=$1`,
      [lessonId],
    );
    expect(await original.query('SELECT 1 FROM google_calendar_oauth_states')).toHaveLength(1);
  } finally {
    await original.close();
  }
  const before = await fingerprint(source);
  const { manifestSha256 } = await createWorkspaceBackup(backupOptions(source, archive));
  const archived = await fingerprint(archive);
  await verifyWorkspaceBackup({
    archiveDir: archive,
    destination,
    expectedManifestSha256: manifestSha256,
  });
  expect(await fingerprint(source)).toBe(before);
  expect(await fingerprint(archive)).toBe(archived);
  const db = await createDatabase({ dataDir: join(destination, 'crm') });
  try {
    expect(await db.query('SELECT 1 FROM google_calendar_oauth_states')).toEqual([]);
    expect(
      await db.query(
        'SELECT id,"calendarId","refreshCiphertext",status,"canReadBusy","calendarClaim" FROM google_calendar_connections',
      ),
    ).toEqual([
      {
        id: 'test-connection',
        calendarId: 'test-calendar',
        refreshCiphertext: null,
        status: 'disconnected',
        canReadBusy: false,
        calendarClaim: null,
      },
    ]);
    expect(
      await db.query(
        'SELECT "lessonId","eventId",state,"desiredVersion","appliedVersion",etag FROM google_calendar_sync',
      ),
    ).toEqual([
      {
        lessonId,
        eventId: 'testevent',
        state: 'pending',
        desiredVersion: 2,
        appliedVersion: 1,
        etag: 'test-etag',
      },
    ]);
  } finally {
    await db.close();
  }
});

it('revokes archived guest credentials and owner sessions only on the verified new copy', async () => {
  const source = await fixture('safe-guest-policy'),
    archive = join(root, 'safe-guest-archive');
  const result = await createWorkspaceBackup(backupOptions(source, archive));
  const before = await fingerprint(source),
    archived = await fingerprint(archive),
    destination = join(root, 'safe-guest-restore');
  const report = await verifyWorkspaceBackup({
    archiveDir: archive,
    destination,
    expectedManifestSha256: result.manifestSha256,
  });
  expect(await fingerprint(source)).toBe(before);
  expect(await fingerprint(archive)).toBe(archived);
  const db = await createDatabase({ dataDir: join(destination, 'crm') });
  try {
    await denied(new BoardService(db).authorizeGuest(boardId, guestToken));
    await denied(new BoardService(db).redeem(boardId, inviteToken));
    expect(
      (await db.query<{ count: string }>('SELECT count(*)::text AS count FROM session'))[0].count,
    ).toBe('0');
  } finally {
    await db.close();
  }
  const original = await createDatabase({ dataDir: join(source, 'crm') });
  try {
    expect((await new BoardService(original).authorizeGuest(boardId, guestToken)).role).toBe(
      'viewer',
    );
  } finally {
    await original.close();
  }
  expect(report).toMatchObject({ guestAccess: 'revoked', ownerSessions: 'cleared' });
});

it.each(['history', 'ledger', 'missing-active', 'init-marker'] as const)(
  'refuses a cold %s inconsistency even when file bytes can be copied',
  async (problem) => {
    const source = await fixture(`invalid-${problem}`),
      path = join(source, 'boards', `${boardId}.sqlite`);
    if (problem === 'missing-active') await rm(path);
    else if (problem === 'history') {
      const db = await createDatabase({ dataDir: join(source, 'crm') });
      try {
        await db.query('UPDATE board_lessons SET "snapshotId"=$1 WHERE "boardId"=$2', [
          randomUUID(),
          boardId,
        ]);
      } finally {
        await db.close();
      }
    } else {
      const db = new DatabaseSync(path);
      try {
        if (problem === 'ledger')
          db.exec("UPDATE tutorflow_code_revisions SET source='synthetic mismatch'");
        else db.exec('DELETE FROM tutorflow_lifecycle');
      } finally {
        db.close();
      }
    }
    const before = await fingerprint(source),
      destination = join(root, `invalid-${problem}-archive`);
    await expect(createWorkspaceBackup(backupOptions(source, destination))).rejects.toMatchObject({
      code:
        problem === 'missing-active'
          ? 'EBOARD_MISSING'
          : problem === 'history'
            ? 'EREFERENCES'
            : 'EBOARD',
    });
    expect(await fingerprint(source)).toBe(before);
    await absent(destination);
  },
);

it('holds both authority locks together throughout the cold capture', async () => {
  const source = await fixture('quiescent-boundary'),
    destination = join(root, 'quiescent-archive');
  const operation = createWorkspaceBackup(backupOptions(source, destination));
  let otherRuntime: BoardRuntime | undefined;
  let otherDb: Awaited<ReturnType<typeof createDatabase>> | undefined;
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const held = await Promise.all([
        access(`${join(source, 'crm')}.lock`).then(
          () => true,
          () => false,
        ),
        access(`${join(source, 'boards')}.lock`).then(
          () => true,
          () => false,
        ),
      ]);
      if (held.every(Boolean)) break;
      await new Promise<void>((done) => setImmediate(done));
    }
    await expect(
      createDatabase({ dataDir: join(source, 'crm') }).then((db) => {
        otherDb = db;
      }),
    ).rejects.toMatchObject({ code: 'ELOCKED' });
    await expect(
      BoardRuntime.open(join(source, 'boards'), { lockRetries: 0 }).then((runtime) => {
        otherRuntime = runtime;
      }),
    ).rejects.toMatchObject({ code: 'ELOCKED' });
    await operation;
  } finally {
    await otherRuntime?.close();
    await otherDb?.close();
    await operation.catch(() => {});
  }
  await absent(`${join(source, 'crm')}.lock`);
  await absent(`${join(source, 'boards')}.lock`);
});

it('refuses an archive whose board authority is open before making a restore copy', async () => {
  const source = await fixture('archive-live'),
    archive = join(root, 'archive-live-archive');
  const result = await createWorkspaceBackup(backupOptions(source, archive));
  const runtime = await BoardRuntime.open(join(archive, 'boards'), { lockRetries: 0 });
  try {
    await expect(
      verifyWorkspaceBackup({
        archiveDir: archive,
        destination: join(root, 'archive-live-restore'),
        expectedManifestSha256: result.manifestSha256,
      }),
    ).rejects.toMatchObject({ code: 'ELOCKED' });
    await absent(join(root, 'archive-live-restore'));
  } finally {
    await runtime.close();
  }
});

it('refuses source names that cannot be represented safely by its manifest', async () => {
  const source = await fixture('unsafe-name');
  await writeFile(join(source, 'boards', 'unsafe\\name'), 'synthetic file');
  const destination = join(root, 'unsafe-name-archive');
  await expect(createWorkspaceBackup(backupOptions(source, destination))).rejects.toMatchObject({
    code: 'EUNSAFE',
  });
  await absent(destination);
});

function killGroup(pid: number | undefined) {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
async function command(args: string[]) {
  const child = spawn(
    'sh',
    ['scripts/tutorflow.sh', 'exec', 'tsx', 'scripts/workspace-backup.ts', ...args],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '',
    timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid);
  }, 25000);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (value: string) => {
    stdout += value;
    if (stdout.length > 64 * 1024) killGroup(child.pid);
  });
  child.stderr.on('data', (value: string) => {
    stderr += value;
    if (stderr.length > 64 * 1024) killGroup(child.pid);
  });
  try {
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (done, reject) => {
        child.once('error', reject);
        child.once('close', (code) =>
          timedOut
            ? reject(new Error('Synthetic workspace CLI timeout'))
            : done({ code, stdout, stderr }),
        );
      },
    );
  } finally {
    clearTimeout(timer);
    killGroup(child.pid);
  }
}
it('runs concrete CLI backup/verify commands without printing secrets, source text or unsafe error arguments', async () => {
  const source = await fixture('cli'),
    archive = join(root, 'cli-archive');
  const args = [
    'backup',
    '--crm',
    join(source, 'crm'),
    '--boards',
    join(source, 'boards'),
    '--source-project',
    process.cwd(),
    '--destination',
    archive,
    '--auth-secret',
    join(source, 'auth-secret'),
  ];
  const result = await command(args);
  expect(result.code).toBe(0);
  const output = JSON.parse(result.stdout) as { status: string; manifestSha256: string };
  expect(output.status).toBe('workspace-backup-created');
  const restored = await command([
    'verify',
    '--archive',
    archive,
    '--destination',
    join(root, 'cli-restored'),
    '--manifest-sha256',
    output.manifestSha256,
  ]);
  expect(restored.code).toBe(0);
  expect(JSON.parse(restored.stdout)).toMatchObject({
    status: 'workspace-restore-verified',
    guestAccess: 'revoked',
    ownerSessions: 'cleared',
  });
  const failed = await command([
    'backup',
    '--crm',
    join(source, 'crm'),
    '--boards',
    join(source, 'boards'),
    '--source-project',
    process.cwd(),
    '--destination',
    join(root, 'cli-refused'),
    '--auth-secret',
    join(source, authSecret),
  ]);
  expect(failed.code).toBe(1);
  for (const response of [result, restored, failed]) {
    for (const sensitive of [
      authSecret,
      guestToken,
      inviteToken,
      'synthetic current',
      'Synthetic student',
    ])
      expect(`${response.stdout}${response.stderr}`).not.toContain(sensitive);
  }
  await absent(join(root, 'cli-refused'));
});

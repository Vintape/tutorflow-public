import { randomUUID, createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuth } from '../server/auth.js';
import type { Config } from '../server/config.js';
import { createDatabase, migrate, type Database } from '../server/db.js';
import { TutorService } from '../server/service.js';
import { emptyReport } from '../shared/domain.js';
import { BoardService } from '../server/boards/service.js';
import { BoardRuntime } from '../server/boards/runtime.js';
import { createWorkspaceBackup } from '../scripts/workspace-backup.js';
import {
  importWorkspacePostgres,
  buildImportClientConfig,
  validateImportTarget,
} from '../scripts/import-workspace-postgres.js';

const suppliedUrl = process.env.TUTORFLOW_TEST_DATABASE_URL;
const password = 'SyntheticTransfer123!';
const config: Config = {
  production: false,
  port: 3198,
  appUrl: 'http://localhost:3198',
  secret: 'synthetic-transfer-auth-secret-not-used-in-production',
  databaseSSL: false,
  dataDir: 'memory://',
  aiModel: 'disabled',
  aiDailyLimit: 1,
};

it('refuses identity collisions and unsafe URI overrides without exposing credentials', () => {
  const target = {
    host: 'db.example.test',
    port: 5432,
    database: 'postgres',
    role: 'tutorflow_app',
    connectionUsername: 'tutorflow_app.expectedproject',
  };
  for (const value of [
    'postgresql://user:private-synthetic-password@[invalid',
    'postgresql://tutorflow_app.expectedproject:private-synthetic-password@db.example.test:5432/postgres?sslmode=verify-full&sslmode=disable',
    'postgresql://tutorflow_app.otherproject:private-synthetic-password@db.example.test:5432/postgres?sslmode=verify-full',
    'postgresql://tutorflow_app:private-synthetic-password@other.test:5432/postgres?sslmode=verify-full',
    'postgresql://tutorflow_app:private-synthetic-password@db.example.test:5432/other?sslmode=verify-full',
    'postgresql://tutorflow_app:private-synthetic-password@db.example.test:5432/postgres?sslmode=disable',
    'postgresql://tutorflow_app:private-synthetic-password@db.example.test:5432/postgres?sslmode=verify-full&options=-csearch_path=public',
  ]) {
    expect(() => validateImportTarget(value, target)).toThrow(/ETARGET/);
    try {
      validateImportTarget(value, target);
    } catch (error) {
      expect(String(error)).not.toContain('private-synthetic-password');
      expect(error).not.toHaveProperty('input');
    }
  }
});

it('enforces remote certificate verification in the actual PostgreSQL client', async () => {
  const url =
    'postgresql://transfer.user:synthetic@db.example.test:5432/postgres?sslmode=verify-full';
  const config = await buildImportClientConfig(url);
  const sslOf = (value: pg.ClientConfig) =>
    (new pg.Client(value) as unknown as { connectionParameters: { ssl: unknown } })
      .connectionParameters.ssl;
  expect(sslOf(config)).toMatchObject({ rejectUnauthorized: true });
  expect(config.connectionString).not.toContain('sslmode');
  const root = await mkdtemp(resolve('.data/tls-config-test-'));
  try {
    const cert = join(root, 'synthetic-ca.pem');
    await writeFile(cert, 'synthetic CA contents');
    const withCa = await buildImportClientConfig(`${url}&sslrootcert=${encodeURIComponent(cert)}`);
    expect(sslOf(withCa)).toMatchObject({
      rejectUnauthorized: true,
      ca: 'synthetic CA contents',
    });
    expect(withCa.connectionString).not.toContain('sslrootcert');
    const local = await buildImportClientConfig(
      'postgresql://synthetic:synthetic@127.0.0.1:5432/synthetic?sslmode=disable',
    );
    expect(sslOf(local)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    await expect(buildImportClientConfig(url)).rejects.toMatchObject({ code: 'ETLS' });
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
});

describe.skipIf(!suppliedUrl)('verified mixed backup → private PostgreSQL import', () => {
  let root: string, admin: pg.Client, db: Database | undefined;
  let archive: string, manifest: string, envFile: string, role: string, database: string;
  let ownerA: string, ownerB: string, studentA: string, lessonA: string, boardA: string;
  let source: string, accountRows: unknown[], sourceFinance: unknown;
  let target: {
    host: string;
    port: number;
    database: string;
    role: string;
    connectionUsername: string;
  };
  let applicationUrl: string, setupUrl: string;

  async function fingerprint(path: string): Promise<string> {
    const hash = createHash('sha256');
    for (const name of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      hash.update(name.name);
      hash.update(
        name.isDirectory()
          ? await fingerprint(join(path, name.name))
          : await readFile(join(path, name.name)),
      );
    }
    return hash.digest('hex');
  }
  const run = (label: string, archiveDir = archive, expectedManifestSha256 = manifest) =>
    importWorkspacePostgres({
      archiveDir,
      expectedManifestSha256,
      restoredDir: join(root, label),
      targetEnvFile: envFile,
      expectedTarget: target,
    });
  beforeAll(async () => {
    const harness = new URL(suppliedUrl!);
    if (
      harness.hostname !== '127.0.0.1' ||
      harness.username !== 'tutorflow_pg_test' ||
      !/^\/tutorflow_pg_harness_[a-zA-Z0-9_]+$/.test(harness.pathname) ||
      harness.search ||
      !harness.port
    )
      throw new Error('Dedicated synthetic PostgreSQL harness required');
    root = await mkdtemp(resolve('.data/postgres-import-test-'));
    source = join(root, 'source');
    await mkdir(source);
    db = await createDatabase({ dataDir: join(source, 'crm') });
    const runtime = await BoardRuntime.open(join(source, 'boards'), { lockRetries: 0 });
    try {
      await migrate(db);
      const auth = createAuth(db, config);
      ownerA = (
        await auth.api.signUpEmail({
          body: { name: 'Synthetic A', email: 'a@transfer.test', password },
        })
      ).user.id;
      ownerB = (
        await auth.api.signUpEmail({
          body: { name: 'Synthetic B', email: 'b@transfer.test', password },
        })
      ).user.id;
      const service = new TutorService(db);
      studentA = (
        await service.createStudent(ownerA, {
          name: 'Synthetic pupil',
          subject: 'Math',
          level: '',
          price: 125001,
          duration: 60,
          goal: '',
          notes: 'Synthetic note',
        })
      ).id;
      const lesson = await service.createLesson(ownerA, {
        studentId: studentA,
        startsAt: '2026-11-01T10:00:00Z',
        topic: 'Synthetic topic',
        allowConflict: false,
      });
      lessonA = lesson.id;
      await service.updateLesson(ownerA, lessonA, {
        version: lesson.version,
        status: 'COMPLETED',
        note: 'Synthetic note',
      });
      await service.pay(ownerA, lessonA, '2026-11-02T12:00:00Z');
      await service.saveReport(ownerA, lessonA, {
        version: 0,
        content: { ...emptyReport, summary: 'Synthetic JSONB Unicode: α' },
        approve: false,
      });
      await db.query(`UPDATE students SET "createdAt"='2026-11-01T10:00:00.123456Z'`);
      const boards = new BoardService(db);
      boardA = (
        await boards.create(ownerA, { title: 'Synthetic transfer board', requestId: randomUUID() })
      ).id;
      runtime.ensure(boardA);
      await boards.activate(ownerA, boardA);
      const snapshotId = runtime.createVersion(boardA, 'Synthetic saved version').id;
      await boards.link(ownerA, boardA, { studentId: studentA, lessonId: lessonA, snapshotId });
      const invitation = await boards.createInvite(ownerA, boardA, {
        role: 'viewer',
        ttlMinutes: 60,
        maxUses: 2,
      });
      await boards.redeem(boardA, invitation.token);
      await db.query(
        `INSERT INTO google_calendar_connections
        ("ownerId",id,"googleSubject","refreshCiphertext","calendarId",status,"canReadBusy","calendarClaim")
        VALUES ($1,'test-connection','test-google-subject','synthetic-encrypted-refresh','test-calendar','connected',true,'synthetic-claim')`,
        [ownerA],
      );
      await db.query(
        `INSERT INTO google_calendar_sync
        ("ownerId","connectionId","lessonId",generation,"eventId","desiredAction","desiredVersion","startsAt",duration)
        SELECT "ownerId",'test-connection',id,1,'testevent','upsert',1,"startsAt",duration
        FROM lessons WHERE id=$1`,
        [lessonA],
      );
      accountRows = await db.query('SELECT * FROM account ORDER BY id COLLATE "C"');
      sourceFinance = await service.finance(ownerA, '2026-11');
    } finally {
      await runtime.close();
      await db.close();
      db = undefined;
    }
    archive = join(root, 'archive');
    manifest = (
      await createWorkspaceBackup({
        crmDir: join(source, 'crm'),
        boardDir: join(source, 'boards'),
        sourceProjectDir: process.cwd(),
        destination: archive,
      })
    ).manifestSha256;
    admin = new pg.Client({ connectionString: suppliedUrl!, connectionTimeoutMillis: 10000 });
    await admin.connect();
    const suffix = randomUUID().replaceAll('-', '');
    database = `tutorflow_pg_harness_import_${suffix}`;
    role = `tutorflow_import_${suffix}`;
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    await admin.query(`CREATE DATABASE "${database}"`);
    harness.pathname = `/${database}`;
    setupUrl = harness.toString();
    const setup = new pg.Client({ connectionString: setupUrl, connectionTimeoutMillis: 10000 });
    await setup.connect();
    try {
      await setup.query(`CREATE SCHEMA tutorflow AUTHORIZATION "${role}"`);
      await setup.query(`REVOKE ALL ON SCHEMA tutorflow FROM PUBLIC`);
      await setup.query(
        `ALTER ROLE "${role}" IN DATABASE "${database}" SET search_path TO tutorflow,pg_catalog`,
      );
    } finally {
      await setup.end();
    }
    harness.username = role;
    harness.password = password;
    applicationUrl = harness.toString();
    target = {
      host: harness.hostname,
      port: Number(harness.port),
      database,
      role,
      connectionUsername: role,
    };
    envFile = join(root, 'connection.env');
    await writeFile(envFile, `DATABASE_URL='${applicationUrl}'\n`, { mode: 0o600 });
  });
  afterAll(async () => {
    await db?.close();
    if (admin) {
      try {
        if (database) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
        if (role) await admin.query(`DROP ROLE "${role}"`);
      } finally {
        await admin.end();
      }
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('rolls migration and every inserted row back when final full-row verification finds a changed value', async () => {
    const setup = new pg.Client({ connectionString: setupUrl, connectionTimeoutMillis: 10000 });
    await setup.connect();
    try {
      await setup.query(`CREATE FUNCTION public.synthetic_corrupt_row() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN NEW.name := 'Synthetic changed value'; RETURN NEW; END $$`);
      await setup.query(`CREATE FUNCTION public.synthetic_install_trigger() RETURNS event_trigger LANGUAGE plpgsql AS $$
        BEGIN IF TG_TAG='CREATE TABLE' AND to_regclass('tutorflow.students') IS NOT NULL AND
          NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='synthetic_corrupt_student') THEN
          CREATE TRIGGER synthetic_corrupt_student BEFORE INSERT ON tutorflow.students
            FOR EACH ROW EXECUTE FUNCTION public.synthetic_corrupt_row();
        END IF; END $$`);
      await setup.query(`CREATE EVENT TRIGGER synthetic_import_fault ON ddl_command_end
        EXECUTE FUNCTION public.synthetic_install_trigger()`);
      await expect(run('rollback-copy')).rejects.toMatchObject({ code: 'EROWS' });
      expect(
        (
          await setup.query(
            "SELECT relname FROM pg_class WHERE relnamespace='tutorflow'::regnamespace",
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await setup.query('DROP EVENT TRIGGER IF EXISTS synthetic_import_fault');
      await setup.query('DROP FUNCTION IF EXISTS public.synthetic_install_trigger()');
      await setup.query('DROP FUNCTION IF EXISTS public.synthetic_corrupt_row()');
      await setup.end();
    }
  });

  it('refuses functions and types already present in the target schema', async () => {
    const setup = new pg.Client({ connectionString: setupUrl, connectionTimeoutMillis: 10000 });
    await setup.connect();
    try {
      await setup.query(
        `CREATE FUNCTION tutorflow.synthetic_collision() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
      );
      await expect(run('function-collision-copy')).rejects.toMatchObject({
        code: 'ETARGET_NOT_EMPTY',
      });
      await setup.query('DROP FUNCTION tutorflow.synthetic_collision()');
      await setup.query("CREATE TYPE tutorflow.synthetic_collision AS ENUM ('synthetic')");
      await expect(run('type-collision-copy')).rejects.toMatchObject({ code: 'ETARGET_NOT_EMPTY' });
      await setup.query('DROP TYPE tutorflow.synthetic_collision');
    } finally {
      await setup.query('DROP FUNCTION IF EXISTS tutorflow.synthetic_collision()');
      await setup.query('DROP TYPE IF EXISTS tutorflow.synthetic_collision');
      await setup.end();
    }
  });

  it('refuses a target with service_role schema access', async () => {
    const setup = new pg.Client({ connectionString: setupUrl, connectionTimeoutMillis: 10000 });
    await setup.connect();
    try {
      await setup.query('CREATE ROLE service_role');
      await setup.query('GRANT USAGE ON SCHEMA tutorflow TO service_role');
      await expect(run('exposed-copy')).rejects.toMatchObject({ code: 'ETARGET_EXPOSED' });
    } finally {
      await setup.query('REVOKE ALL ON SCHEMA tutorflow FROM service_role');
      await setup.query('DROP ROLE IF EXISTS service_role');
      await setup.end();
    }
  });

  it('imports the archived pre-Calendar schema without replaying newer migrations', async () => {
    const oldSource = join(root, 'pre-calendar-source'),
      oldArchive = join(root, 'pre-calendar-archive');
    await cp(source, oldSource, { recursive: true });
    const oldCrm = await createDatabase({ dataDir: join(oldSource, 'crm') });
    try {
      await oldCrm.query('DROP TABLE google_calendar_sync');
      await oldCrm.query('DROP TABLE google_calendar_oauth_states, google_calendar_connections');
      await oldCrm.query("DELETE FROM _migrations WHERE name >= '0003'");
    } finally {
      await oldCrm.close();
    }
    const { manifestSha256 } = await createWorkspaceBackup({
      crmDir: join(oldSource, 'crm'),
      boardDir: join(oldSource, 'boards'),
      sourceProjectDir: process.cwd(),
      destination: oldArchive,
    });
    const setup = new pg.Client({ connectionString: setupUrl, connectionTimeoutMillis: 10000 });
    await setup.connect();
    try {
      const result = await run('pre-calendar-restored', oldArchive, manifestSha256);
      expect(result.tables._migrations.count).toBe(2);
      expect(result.tables).not.toHaveProperty('google_calendar_connections');
      expect(
        (await setup.query('SELECT name FROM tutorflow._migrations ORDER BY name')).rows,
      ).toEqual([{ name: '0001_initial.sql' }, { name: '0002_boards.sql' }]);
      expect(
        (
          await setup.query(
            "SELECT tablename FROM pg_tables WHERE schemaname='tutorflow' AND tablename LIKE 'google_calendar_%'",
          )
        ).rows,
      ).toEqual([]);
      expect((await setup.query('SELECT id FROM tutorflow.lessons')).rows).toEqual([{ id: lessonA }]);
    } finally {
      await setup.query('DROP SCHEMA tutorflow CASCADE');
      await setup.query(`CREATE SCHEMA tutorflow AUTHORIZATION "${role}"`);
      await setup.query('REVOKE ALL ON SCHEMA tutorflow FROM PUBLIC');
      await setup.end();
    }
  });

  it('refuses a Calendar-looking table outside the checked-in migration allowlist', async () => {
    const extraSource = join(root, 'extra-calendar-source'),
      extraArchive = join(root, 'extra-calendar-archive');
    await cp(source, extraSource, { recursive: true });
    const extraCrm = await createDatabase({ dataDir: join(extraSource, 'crm') });
    try {
      await extraCrm.query('CREATE TABLE google_calendar_extra (id text PRIMARY KEY)');
    } finally {
      await extraCrm.close();
    }
    const { manifestSha256 } = await createWorkspaceBackup({
      crmDir: join(extraSource, 'crm'),
      boardDir: join(extraSource, 'boards'),
      sourceProjectDir: process.cwd(),
      destination: extraArchive,
    });
    await expect(run('extra-calendar-restored', extraArchive, manifestSha256)).rejects.toMatchObject({
      code: 'ESOURCE_SCHEMA',
    });
    await expect(stat(join(root, 'extra-calendar-restored'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('imports full rows, money and board links, preserves login, excludes canvas and leaves source/archive unchanged', async () => {
    const beforeSource = await fingerprint(source),
      beforeArchive = await fingerprint(archive);
    const result = await run('restored');
    expect(result.tables.account.count).toBe(2);
    expect(result.tables.reports.count).toBe(1);
    expect(result.tables.session.count).toBe(0);
    expect(result.tables.google_calendar_connections?.count).toBe(1);
    expect(result.tables.google_calendar_oauth_states?.count).toBe(0);
    expect(result.tables.google_calendar_sync?.count).toBe(1);
    expect(result.finance).toMatchObject({
      payments: 1,
      activePayments: 1,
      receivedKopecks: '125001',
      completedLessons: 1,
    });
    expect(await fingerprint(source)).toBe(beforeSource);
    expect(await fingerprint(archive)).toBe(beforeArchive);
    db = await createDatabase({ databaseUrl: applicationUrl, dataDir: 'memory://' });
    expect(
      await db.query(`SELECT to_char("createdAt",'US') AS micros FROM students WHERE id=$1`, [
        studentA,
      ]),
    ).toEqual([{ micros: '123456' }]);
    expect(await db.query('SELECT content FROM reports')).toEqual([
      { content: { ...emptyReport, summary: 'Synthetic JSONB Unicode: α' } },
    ]);
    await migrate(db); // Existing startup path must resolve all tables privately.
    expect(
      await db.query(
        'SELECT id,"refreshCiphertext",status,"canReadBusy","calendarClaim" FROM google_calendar_connections',
      ),
    ).toEqual([
      {
        id: 'test-connection',
        refreshCiphertext: null,
        status: 'disconnected',
        canReadBusy: false,
        calendarClaim: null,
      },
    ]);
    expect(
      await db.query(
        'SELECT "lessonId","eventId",state,candidate IS NULL AS "noCandidate" FROM google_calendar_sync',
      ),
    ).toEqual([{ lessonId: lessonA, eventId: 'testevent', state: 'pending', noCandidate: true }]);
    expect(await db.query('SELECT * FROM account ORDER BY id COLLATE "C"')).toEqual(accountRows);
    const auth = createAuth(db, config);
    const signin = await auth.api.signInEmail({ body: { email: 'a@transfer.test', password } });
    expect(signin.user.id).toBe(ownerA);
    const service = new TutorService(db);
    expect(await service.finance(ownerA, '2026-11')).toEqual(sourceFinance);
    await expect(service.student(ownerB, studentA)).rejects.toMatchObject({ status: 404 });
    const boards = new BoardService(db);
    expect((await boards.get(ownerA, boardA)).id).toBe(boardA);
    await expect(boards.get(ownerB, boardA)).rejects.toMatchObject({ status: 404 });
    expect(await db.query('SELECT "boardId","lessonId","snapshotId" FROM board_lessons')).toEqual([
      expect.objectContaining({
        boardId: boardA,
        lessonId: lessonA,
        snapshotId: expect.any(String),
      }),
    ]);
    expect(await db.query('SELECT 1 FROM board_invitations WHERE "revokedAt" IS NULL')).toEqual([]);
    expect(await db.query('SELECT 1 FROM board_guest_sessions WHERE "revokedAt" IS NULL')).toEqual(
      [],
    );
    expect(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).toEqual([]);
    expect(
      await db.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='tutorflow' AND tablename LIKE '%canvas%'",
      ),
    ).toEqual([]);
    await db.close();
    db = undefined;
  });

  it('refuses an existing target without deleting any rows', async () => {
    const client = new pg.Client({ connectionString: applicationUrl });
    await client.connect();
    try {
      const before = (await client.query('SELECT count(*)::text AS count FROM tutorflow."user"'))
        .rows;
      await expect(run('second-copy')).rejects.toMatchObject({ code: 'ETARGET_NOT_EMPTY' });
      expect(
        (await client.query('SELECT count(*)::text AS count FROM tutorflow."user"')).rows,
      ).toEqual(before);
    } finally {
      await client.end();
    }
  });
  it('retains the restored copy and reports uncertainty if COMMIT succeeds but its reply is lost', async () => {
    const setup = new pg.Client({ connectionString: setupUrl, connectionTimeoutMillis: 10000 });
    await setup.connect();
    try {
      await setup.query('DROP SCHEMA tutorflow CASCADE');
      await setup.query(`CREATE SCHEMA tutorflow AUTHORIZATION "${role}"`);
      await setup.query('REVOKE ALL ON SCHEMA tutorflow FROM PUBLIC');
      const original = pg.Client.prototype.query;
      const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (
        this: pg.Client,
        ...args: unknown[]
      ) {
        const result = Reflect.apply(original, this, args);
        if (args[0] === 'COMMIT')
          return Promise.resolve(result).then(() => {
            throw new Error('Synthetic lost COMMIT reply');
          });
        return result;
      } as typeof original);
      try {
        await expect(run('uncertain-copy')).rejects.toMatchObject({ code: 'ECOMMIT_UNCERTAIN' });
      } finally {
        spy.mockRestore();
      }
      expect((await stat(join(root, 'uncertain-copy'))).isDirectory()).toBe(true);
      expect(
        (await setup.query('SELECT count(*)::integer AS count FROM tutorflow."user"')).rows,
      ).toEqual([{ count: 2 }]);
    } finally {
      await setup.end();
    }
  });
});

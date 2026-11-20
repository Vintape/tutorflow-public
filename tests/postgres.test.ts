import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth } from '../server/auth.js';
import type { Config } from '../server/config.js';
import { createDatabase, migrate, type Database } from '../server/db.js';
import { TutorService } from '../server/service.js';
import { emptyReport } from '../shared/domain.js';

// Deliberately never fall back to DATABASE_URL or the user's PGlite directory.
const suppliedUrl = process.env.TUTORFLOW_TEST_DATABASE_URL;
const databaseName = `tutorflow_pg_test_${randomUUID().replaceAll('-', '')}`;
const password = 'OnlySyntheticPostgres123!';
const config: Config = {
  production: false,
  port: 3198,
  appUrl: 'http://localhost:3198',
  secret: 'synthetic-postgres-integration-secret-not-for-real-use',
  databaseSSL: false,
  dataDir: 'memory://',
  aiModel: 'not-used',
  aiDailyLimit: 20,
};

function isolatedHarnessUrl(value: string): URL {
  const message = 'PostgreSQL tests require the dedicated loopback synthetic harness database';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // The native URL error carries its original input, including credentials.
    throw new Error(message);
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    !url.port ||
    !!url.search ||
    url.username !== 'tutorflow_pg_test' ||
    !/^\/tutorflow_pg_harness_[a-zA-Z0-9_]+$/.test(url.pathname)
  ) {
    throw new Error(message);
  }
  return url;
}

describe('PostgreSQL harness isolation guard', () => {
  it.each([
    'postgresql://tutorflow_pg_test:synthetic@db.example:55438/tutorflow_pg_harness_test',
    'postgresql://tutorflow_pg_test:synthetic@127.0.0.1:55438/tutorflow',
    'postgresql://other:synthetic@127.0.0.1:55438/tutorflow_pg_harness_test',
    'postgresql://tutorflow_pg_test:synthetic@127.0.0.1/tutorflow_pg_harness_test',
    'postgresql://tutorflow_pg_test:synthetic@127.0.0.1:55438/tutorflow_pg_harness_test?host=db.example',
    'postgresql://tutorflow_pg_test:synthetic@127.0.0.1:55438/tutorflow_pg_harness_test?dbname=other',
  ])('refuses an unmarked or non-loopback connection before connecting (%#)', (value) => {
    expect(() => isolatedHarnessUrl(value)).toThrow('dedicated loopback synthetic harness');
  });
  it('does not expose malformed connection credentials in the thrown error', () => {
    let failure: unknown;
    try {
      isolatedHarnessUrl('postgresql://synthetic-credential@[invalid');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toHaveProperty('input');
    expect(JSON.stringify(failure)).not.toContain('synthetic-credential');
  });
});

describe.skipIf(!suppliedUrl)(
  'real PostgreSQL (requires TUTORFLOW_TEST_DATABASE_URL; run scripts/test-postgres.sh)',
  () => {
    let admin: pg.Client | undefined;
    let databaseCreated = false;
    let db: Database | undefined;
    let peer: Database | undefined;
    let service: TutorService;
    let peerService: TutorService;
    let testUrl: string;
    let ownerA: string, ownerB: string, studentA: string, studentB: string;
    let nextDay = 1;

    function connection() {
      return createDatabase({ databaseUrl: testUrl, databaseSSL: false, dataDir: 'memory://' });
    }

    async function completedLesson() {
      const lesson = await service.createLesson(ownerA, {
        studentId: studentA,
        startsAt: new Date(Date.UTC(2020, 0, nextDay++, 10)).toISOString(),
        topic: 'Synthetic PostgreSQL lesson',
        allowConflict: false,
      });
      return service.updateLesson(ownerA, lesson.id, {
        version: lesson.version,
        status: 'COMPLETED',
        note: 'Synthetic note',
      });
    }

    beforeAll(async () => {
      const url = isolatedHarnessUrl(suppliedUrl!);
      admin = new pg.Client({ connectionString: url.toString() });
      await admin.connect();
      // The identifier is generated here from hex UUID characters, never from input.
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      url.pathname = `/${databaseName}`;
      testUrl = url.toString();
      db = await connection();
      await migrate(db);
      peer = await connection();
      service = new TutorService(db);
      peerService = new TutorService(peer);
      const auth = createAuth(db, config);
      for (const name of ['a', 'b'] as const) {
        const signup = await auth.api.signUpEmail({
          body: { name: `Synthetic ${name}`, email: `${name}@postgres.tutorflow.test`, password },
        });
        if (name === 'a') ownerA = signup.user.id;
        else ownerB = signup.user.id;
      }
      for (const [owner, name] of [
        [ownerA, 'A'],
        [ownerB, 'B'],
      ]) {
        const student = await service.createStudent(owner, {
          name: `Synthetic student ${name}`,
          subject: 'Mathematics',
          level: '',
          price: 150000,
          duration: 60,
          goal: '',
          notes: '',
        });
        if (name === 'A') studentA = student.id;
        else studentB = student.id;
      }
    });

    afterAll(async () => {
      try {
        await Promise.all([db?.close(), peer?.close()]);
      } finally {
        try {
          if (databaseCreated) await admin!.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        } finally {
          await admin?.end();
        }
      }
    });

    it('uses a network PostgreSQL server and applies every migration exactly once', async () => {
      const [server] = await db!.query<{ name: string; address: string; version: string }>(
        `SELECT current_database() AS name, inet_server_addr()::text AS address,
         current_setting('server_version') AS version`,
      );
      expect(server.name).toBe(databaseName);
      expect(server.address).toBeTruthy();
      expect(server.version).toMatch(/^\d+\./);
      const before = await db!.query('SELECT name, hash FROM _migrations ORDER BY name');
      const files = (await readdir('migrations')).filter((name) => name.endsWith('.sql')).sort();
      expect(before.map((row) => row.name)).toEqual(files);
      expect(before.length).toBeGreaterThan(0);
      await migrate(db!);
      expect(await db!.query('SELECT name, hash FROM _migrations ORDER BY name')).toEqual(before);
    });

    it('authenticates with Better Auth and prevents cross-owner service access', async () => {
      const login = await createAuth(db!, config).api.signInEmail({
        body: { email: 'b@postgres.tutorflow.test', password },
      });
      expect(login.user.id).toBe(ownerB);
      expect((await service.listStudents(ownerA)).map((student) => student.id)).toEqual([studentA]);
      expect((await service.listStudents(ownerB)).map((student) => student.id)).toEqual([studentB]);
      await expect(service.student(ownerB, studentA)).rejects.toMatchObject({ status: 404 });
      await expect(
        service.createLesson(ownerB, {
          studentId: studentA,
          startsAt: '2020-02-01T10:00:00.000Z',
          topic: '',
          allowConflict: false,
        }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('enforces composite ownership foreign keys even when service checks are bypassed', async () => {
      await expect(
        db!.query(
          `INSERT INTO lessons (id,"ownerId","studentId","startsAt",duration,price)
         VALUES ($1,$2,$3,$4,60,150000)`,
          [randomUUID(), ownerB, studentA, '2020-02-02T10:00:00.000Z'],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      const lesson = await completedLesson();
      await expect(service.lessonDetail(ownerB, lesson.id)).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        db!.query(
          `INSERT INTO payments (id,"ownerId","lessonId",amount,"paidAt")
         VALUES ($1,$2,$3,150000,$4)`,
          [randomUUID(), ownerB, lesson.id, '2020-01-15T12:00:00.000Z'],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('serializes concurrent payments from independent PostgreSQL pools', async () => {
      const [first] = await db!.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const [second] = await peer!.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect(first.pid).not.toBe(second.pid);
      const lesson = await completedLesson();
      const before = await service.finance(ownerA, '2020-01');
      const payments = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          (index % 2 ? service : peerService).pay(ownerA, lesson.id, '2020-01-15T12:00:00.000Z'),
        ),
      );
      expect(new Set(payments.map((payment) => payment.id)).size).toBe(1);
      expect(payments.every((payment) => payment.amount === 150000)).toBe(true);
      const after = await service.finance(ownerA, '2020-01');
      expect(after.received).toBe(before.received + 150000);
      expect(after.debt).toBe(before.debt - 150000);
      const detail = await service.lessonDetail(ownerA, lesson.id);
      expect(detail.payments).toHaveLength(1);
      expect(detail.payments[0].voidedAt).toBeNull();
    });

    it('preserves reversal history and rejects a duplicate active payment at the SQL boundary', async () => {
      const lesson = await completedLesson();
      const original = await service.pay(ownerA, lesson.id, '2020-01-15T12:00:00.000Z');
      await expect(service.reversePayment(ownerB, original.id)).rejects.toMatchObject({
        status: 404,
      });
      await service.reversePayment(ownerA, original.id);
      await service.reversePayment(ownerA, original.id);
      const replacement = await service.pay(ownerA, lesson.id, '2020-01-16T12:00:00.000Z');
      expect(replacement.id).not.toBe(original.id);
      const detail = await service.lessonDetail(ownerA, lesson.id);
      expect(detail.payments).toHaveLength(2);
      expect(detail.payments.filter((payment) => payment.voidedAt === null)).toHaveLength(1);
      expect(detail.payments.find((payment) => payment.id === original.id)?.voidedAt).toBeTruthy();
      await expect(
        db!.query(
          `INSERT INTO payments (id,"ownerId","lessonId",amount,"paidAt")
         VALUES ($1,$2,$3,150000,$4)`,
          [randomUUID(), ownerA, lesson.id, '2020-01-16T12:00:00.000Z'],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('rolls back all writes on callback failure and leaves the pool usable', async () => {
      const inserted = randomUUID();
      const failure = new Error('Synthetic transaction abort');
      await expect(
        db!.transaction(async (tx) => {
          await tx.query('UPDATE students SET notes=$2 WHERE id=$1', [studentA, 'must roll back']);
          await tx.query(
            `INSERT INTO students (id,"ownerId",name,subject,price,duration)
           VALUES ($1,$2,$3,$4,150000,60)`,
            [inserted, ownerA, 'Synthetic rollback student', 'Mathematics'],
          );
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect((await service.student(ownerA, studentA)).notes).toBe('');
      expect(await db!.query('SELECT id FROM students WHERE id=$1', [inserted])).toEqual([]);
      expect(await db!.query('SELECT 1 AS healthy')).toEqual([{ healthy: 1 }]);
    });

    it('keeps the synthetic account, lesson, reviewed report and payment after closing and reopening the adapter', async () => {
      let reopened: Database | undefined;
      const writer = await connection();
      let writerClosed = false;
      try {
        const signup = await createAuth(writer, config).api.signUpEmail({
          body: {
            name: 'Synthetic persistence owner',
            email: 'reopen@postgres.tutorflow.test',
            password,
          },
        });
        const writing = new TutorService(writer);
        const student = await writing.createStudent(signup.user.id, {
          name: 'Synthetic persistent student',
          subject: 'Physics',
          level: '',
          price: 123456,
          duration: 60,
          goal: '',
          notes: '',
        });
        const planned = await writing.createLesson(signup.user.id, {
          studentId: student.id,
          startsAt: '2020-03-01T10:00:00.000Z',
          topic: 'Persistence',
          allowConflict: false,
        });
        const lesson = await writing.updateLesson(signup.user.id, planned.id, {
          version: planned.version,
          status: 'COMPLETED',
          note: 'Synthetic durable note',
        });
        await writing.saveReport(signup.user.id, lesson.id, {
          content: { ...emptyReport, topic: 'Synthetic reviewed report' },
          approve: true,
          version: 0,
        });
        await writing.pay(signup.user.id, lesson.id, '2020-03-02T12:00:00.000Z');
        await writer.close();
        writerClosed = true;
        reopened = await connection();
        await migrate(reopened);
        const login = await createAuth(reopened, config).api.signInEmail({
          body: { email: 'reopen@postgres.tutorflow.test', password },
        });
        expect(login.user.id).toBe(signup.user.id);
        const detail = await new TutorService(reopened).lessonDetail(login.user.id, lesson.id);
        expect(detail.lesson.note).toBe('Synthetic durable note');
        expect(detail.lesson.price).toBe(123456);
        expect(detail.report?.status).toBe('APPROVED');
        expect(detail.report?.content.topic).toBe('Synthetic reviewed report');
        expect(detail.payments.map((payment) => payment.amount)).toEqual([123456]);
      } finally {
        if (!writerClosed) await writer.close();
        await reopened?.close();
      }
    });
  },
);

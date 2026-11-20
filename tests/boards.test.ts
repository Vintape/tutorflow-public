import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, migrate, type Database } from '../server/db.js';
import { BoardService } from '../server/boards/service.js';
import {
  boardCreateInput,
  boardRenameInput,
  boardInviteInput,
  boardLinkInput,
} from '../shared/boards.js';

let db: Database;
let service: BoardService;
let admin: pg.Client | undefined;
let databaseCreated = false;
const databaseName = `tutorflow_board_test_${randomUUID().replaceAll('-', '')}`;
const suppliedUrl = process.env.TUTORFLOW_TEST_DATABASE_URL;
function harnessUrl(value: string): URL {
  const message = 'Board tests require a dedicated loopback synthetic PostgreSQL harness';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    !url.port ||
    !!url.search ||
    url.username !== 'tutorflow_pg_test' ||
    !/^\/tutorflow_pg_harness_[a-zA-Z0-9_]+$/.test(url.pathname)
  )
    throw new Error(message);
  return url;
}
const ownerA = 'synthetic-board-owner-a';
const ownerB = 'synthetic-board-owner-b';
const studentA = randomUUID();
const studentB = randomUUID();
const lessonA = randomUUID();
beforeAll(async () => {
  if (suppliedUrl) {
    const url = harnessUrl(suppliedUrl);
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    // Only a locally generated hex identifier reaches this SQL identifier.
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    url.pathname = `/${databaseName}`;
    db = await createDatabase({
      databaseUrl: url.toString(),
      dataDir: 'memory://',
      databaseSSL: false,
    });
  } else db = await createDatabase({ dataDir: 'memory://' });
  await migrate(db);
  service = new BoardService(db);
  for (const owner of [ownerA, ownerB]) {
    await db.query('INSERT INTO "user" (id,name,email) VALUES ($1,$1,$2)', [
      owner,
      `${owner}@tutorflow.test`,
    ]);
  }
  for (const [owner, student] of [
    [ownerA, studentA],
    [ownerB, studentB],
  ]) {
    await db.query(
      'INSERT INTO students (id,"ownerId",name,subject,price,duration) VALUES ($1,$2,$3,$3,0,60)',
      [student, owner, 'Synthetic'],
    );
  }
  await db.query(
    'INSERT INTO lessons (id,"ownerId","studentId","startsAt",price,duration) VALUES ($1,$2,$3,now(),0,60)',
    [lessonA, ownerA, studentA],
  );
});
afterAll(async () => {
  try {
    await db?.close();
  } finally {
    try {
      if (databaseCreated) await admin!.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    } finally {
      await admin?.end();
    }
  }
});

it('creates board metadata and separate invitation/session SQL tables', async () => {
  const tables = await db.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('boards','board_students','board_lessons','board_invitations','board_guest_sessions') ORDER BY table_name",
  );
  expect(tables.map((row) => row.table_name)).toEqual([
    'board_guest_sessions',
    'board_invitations',
    'board_lessons',
    'board_students',
    'boards',
  ]);
});

it('enforces owner-safe CRM and guest references independently of the service', async () => {
  const board = randomUUID();
  const invite = randomUUID();
  await db.query('INSERT INTO boards (id,"ownerId",title,"requestId") VALUES ($1,$2,$3,$4)', [
    board,
    ownerA,
    'Synthetic board',
    randomUUID(),
  ]);
  await expect(
    db.query('INSERT INTO board_students ("boardId","ownerId","studentId") VALUES ($1,$2,$3)', [
      board,
      ownerB,
      studentB,
    ]),
  ).rejects.toMatchObject({ code: '23503' });
  await expect(
    db.query('INSERT INTO board_students ("boardId","ownerId","studentId") VALUES ($1,$2,$3)', [
      board,
      ownerA,
      studentB,
    ]),
  ).rejects.toMatchObject({ code: '23503' });
  await expect(
    db.query('INSERT INTO board_lessons ("boardId","ownerId","lessonId") VALUES ($1,$2,$3)', [
      board,
      ownerB,
      lessonA,
    ]),
  ).rejects.toMatchObject({ code: '23503' });
  await db.query(
    'INSERT INTO board_invitations (id,"ownerId","boardId",role,"tokenDigest","expiresAt","maxUses") VALUES ($1,$2,$3,$4,$5,now()+interval \'1 hour\',1)',
    [invite, ownerA, board, 'editor', 'a'.repeat(64)],
  );
  await expect(
    db.query(
      'INSERT INTO board_guest_sessions (id,"ownerId","boardId","invitationId",role,"tokenDigest","expiresAt") VALUES ($1,$2,$3,$4,$5,$6,now()+interval \'10 minutes\')',
      [randomUUID(), ownerB, board, invite, 'editor', 'b'.repeat(64)],
    ),
  ).rejects.toMatchObject({ code: '23503' });
  await expect(
    db.query(
      'INSERT INTO board_guest_sessions (id,"ownerId","boardId","invitationId",role,"tokenDigest","expiresAt") VALUES ($1,$2,$3,$4,$5,$6,now()+interval \'10 minutes\')',
      [randomUUID(), ownerA, board, invite, 'viewer', 'b'.repeat(64)],
    ),
  ).rejects.toMatchObject({ code: '23503' });
});

it('enforces lifecycle, nonblank titles, UUID retries, secret digests and bounded invitation usage in SQL', async () => {
  const board = randomUUID();
  await expect(
    db.query('INSERT INTO boards (id,"ownerId",title,"requestId",state) VALUES ($1,$2,$3,$4,$5)', [
      board,
      ownerA,
      'Board',
      randomUUID(),
      'BROKEN',
    ]),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    db.query('INSERT INTO boards (id,"ownerId",title,"requestId") VALUES ($1,$2,$3,$4)', [
      board,
      ownerA,
      '  ',
      randomUUID(),
    ]),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    db.query('INSERT INTO boards (id,"ownerId",title,"requestId") VALUES ($1,$2,$3,$4)', [
      board,
      ownerA,
      'Board',
      'not-uuid',
    ]),
  ).rejects.toMatchObject({ code: '22P02' });
  const request = randomUUID();
  await db.query('INSERT INTO boards (id,"ownerId",title,"requestId") VALUES ($1,$2,$3,$4)', [
    board,
    ownerA,
    'Board',
    request,
  ]);
  await expect(
    db.query('INSERT INTO boards (id,"ownerId",title,"requestId") VALUES ($1,$2,$3,$4)', [
      randomUUID(),
      ownerA,
      'Duplicate',
      request,
    ]),
  ).rejects.toMatchObject({ code: '23505' });
  for (const [role, digest, maxUses, uses] of [
    ['admin', 'c'.repeat(64), 1, 0],
    ['editor', 'raw-secret', 1, 0],
    ['editor', 'd'.repeat(64), 0, 0],
    ['editor', 'e'.repeat(64), 1001, 0],
    ['editor', 'f'.repeat(64), 1, 2],
  ]) {
    await expect(
      db.query(
        'INSERT INTO board_invitations (id,"ownerId","boardId",role,"tokenDigest","expiresAt","maxUses",uses) VALUES ($1,$2,$3,$4,$5,now()+interval \'1 hour\',$6,$7)',
        [randomUUID(), ownerA, board, role, digest, maxUses, uses],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  }
});

async function board(owner = ownerA) {
  const created = await service.create(owner, {
    title: 'Synthetic independent board',
    requestId: randomUUID(),
  });
  return service.activate(owner, created.id);
}
async function stored() {
  const rows: Record<string, unknown[]> = {};
  for (const name of [
    'boards',
    'board_lessons',
    'board_students',
    'board_invitations',
    'board_guest_sessions',
  ])
    rows[name] = await db.query(`SELECT * FROM ${name} ORDER BY 1`);
  return rows;
}
it('strictly validates metadata, invitation budgets and link shape', () => {
  expect(boardCreateInput.parse({ title: '  Board  ', requestId: randomUUID() }).title).toBe(
    'Board',
  );
  for (const input of [
    { title: ' ', requestId: randomUUID() },
    { title: 'Board', requestId: 'retry' },
    { title: 'Board', requestId: randomUUID(), ownerId: ownerB },
  ])
    expect(boardCreateInput.safeParse(input).success).toBe(false);
  expect(boardRenameInput.safeParse({ title: 'x'.repeat(201) }).success).toBe(false);
  for (const input of [
    { role: 'admin', ttlMinutes: 60 },
    { role: 'editor', ttlMinutes: 0 },
    { role: 'viewer', ttlMinutes: 10081 },
    { role: 'viewer', ttlMinutes: 1, maxUses: 1001 },
    { role: 'viewer', ttlMinutes: 1, maxUses: 0 },
    { role: 'viewer', ttlMinutes: 1, token: 'no' },
  ])
    expect(boardInviteInput.safeParse(input).success).toBe(false);
  expect(boardInviteInput.parse({ role: 'viewer', ttlMinutes: 1 }).maxUses).toBe(1);
  for (const input of [
    {},
    { studentId: 'other' },
    { snapshotId: 'history' },
    { studentId: studentA, snapshotId: 'history' },
    { lessonId: lessonA, ownerId: ownerB },
  ])
    expect(boardLinkInput.safeParse(input).success).toBe(false);
  expect(
    boardLinkInput.safeParse({ lessonId: lessonA, studentId: studentA, snapshotId: null }).success,
  ).toBe(true);
});
it('retries creation by owner/request UUID without changing title or duplicating a board', async () => {
  const requestId = randomUUID();
  const [first, retry] = await Promise.all([
    service.create(ownerA, { title: 'Original', requestId }),
    service.create(ownerA, { title: 'Ignored retry change', requestId }),
  ]);
  expect(retry).toEqual(first);
  expect(first.state).toBe('CREATING');
  expect(first.requestId).toBe(requestId);
  expect(Date.parse(first.createdAt)).not.toBeNaN();
  expect((await service.get(ownerA, first.id)).id).toBe(first.id);
  const anotherOwner = await service.create(ownerB, { title: 'Other owner', requestId });
  expect(anotherOwner.id).not.toBe(first.id);
  const active = await service.activate(ownerA, first.id);
  expect(active.state).toBe('ACTIVE');
  expect((await service.create(ownerA, { title: 'Retry after activation', requestId })).id).toBe(
    first.id,
  );
  expect((await service.rename(ownerA, first.id, 'Renamed')).title).toBe('Renamed');
  expect((await service.activate(ownerA, first.id)).state).toBe('ACTIVE');
});
it('rejects foreign owner metadata/links/invites and leaves all stored data unchanged', async () => {
  const active = await board();
  const invite = await service.createInvite(ownerA, active.id, {
    role: 'viewer',
    ttlMinutes: 60,
    maxUses: 2,
  });
  const before = await stored();
  const operations = [
    () => service.get(ownerB, active.id),
    () => service.activate(ownerB, active.id),
    () => service.rename(ownerB, active.id, 'Attacker title'),
    () => service.remove(ownerB, active.id),
    () => service.links(ownerB, active.id),
    () => service.link(ownerB, active.id, { studentId: studentB }),
    () => service.unlink(ownerB, active.id, { lessonId: lessonA }),
    () => service.link(ownerA, active.id, { studentId: studentB }),
    () => service.link(ownerA, active.id, { lessonId: lessonA, studentId: studentB }),
    () => service.listInvites(ownerB, active.id),
    () => service.createInvite(ownerB, active.id, { role: 'editor', ttlMinutes: 5, maxUses: 1 }),
    () => service.revokeInvite(ownerB, active.id, invite.invite.id),
  ];
  for (const operation of operations)
    await expect(operation()).rejects.toMatchObject({ status: 404 });
  expect(await stored()).toEqual(before);
  expect((await service.list(ownerB)).some((item) => item.id === active.id)).toBe(false);
});
it('links independent boards many-to-many, updates snapshot references, and only detaches CRM deletions', async () => {
  const first = await board(),
    second = await board();
  const student = randomUUID(),
    lesson = randomUUID();
  await db.query(
    'INSERT INTO students (id,"ownerId",name,subject,price,duration) VALUES ($1,$2,$3,$3,0,60)',
    [student, ownerA, 'Synthetic linked'],
  );
  await db.query(
    'INSERT INTO lessons (id,"ownerId","studentId","startsAt",price,duration) VALUES ($1,$2,$3,now(),0,60)',
    [lesson, ownerA, student],
  );
  for (const item of [first, second])
    await service.link(ownerA, item.id, {
      studentId: student,
      lessonId: lesson,
      snapshotId: 'future-history-reference',
    });
  expect(await service.links(ownerA, first.id)).toMatchObject({
    students: [{ studentId: student }],
    lessons: [{ lessonId: lesson, snapshotId: 'future-history-reference' }],
  });
  await service.link(ownerA, first.id, { lessonId: lesson });
  expect((await service.links(ownerA, first.id)).lessons[0].snapshotId).toBe(
    'future-history-reference',
  );
  await service.link(ownerA, first.id, { lessonId: lesson, snapshotId: null });
  expect((await service.links(ownerA, first.id)).lessons[0].snapshotId).toBeNull();
  await service.unlink(ownerA, first.id, { studentId: student });
  expect((await service.links(ownerA, first.id)).students).toEqual([]);
  await db.query('DELETE FROM lessons WHERE id=$1', [lesson]);
  for (const item of [first, second])
    expect((await service.links(ownerA, item.id)).lessons).toEqual([]);
  await db.query('DELETE FROM students WHERE id=$1', [student]);
  expect((await service.links(ownerA, second.id)).students).toEqual([]);
  expect((await service.get(ownerA, first.id)).state).toBe('ACTIVE');
  expect((await service.get(ownerA, second.id)).state).toBe('ACTIVE');
});
it('never activates a tombstone or recreates it through the same request ID', async () => {
  const active = await board();
  const invite = await service.createInvite(ownerA, active.id, {
    role: 'editor',
    ttlMinutes: 60,
    maxUses: 2,
  });
  const guest = await service.redeem(active.id, invite.token);
  await service.remove(ownerA, active.id);
  await service.remove(ownerA, active.id); // explicit cleanup retries are idempotent.
  expect((await db.query('SELECT state FROM boards WHERE id=$1', [active.id]))[0].state).toBe(
    'DELETED',
  );
  expect((await service.list(ownerA)).some((item) => item.id === active.id)).toBe(false);
  for (const operation of [
    () => service.get(ownerA, active.id),
    () => service.activate(ownerA, active.id),
    () => service.rename(ownerA, active.id, 'Resurrect'),
    () => service.create(ownerA, { title: 'Resurrect', requestId: active.requestId }),
    () => service.redeem(active.id, invite.token),
    () => service.authorizeGuest(active.id, guest.token),
  ])
    await expect(operation()).rejects.toMatchObject({ status: 404 });
  const rows = await db.query('SELECT "revokedAt" FROM board_guest_sessions WHERE "boardId"=$1', [
    active.id,
  ]);
  expect(rows[0].revokedAt).toBeTruthy();
});
it('keeps invitations separate from sessions and returns guest scope without owner/CRM metadata', async () => {
  const active = await board();
  await service.link(ownerA, active.id, { studentId: studentA, lessonId: lessonA });
  const created = await service.createInvite(ownerA, active.id, {
    role: 'viewer',
    ttlMinutes: 60,
    maxUses: 2,
  });
  expect(created.token).toMatch(/^[0-9a-f]{64}$/);
  const guest = await service.redeem(active.id, created.token);
  expect(guest.token).toMatch(/^[0-9a-f]{64}$/);
  expect(guest.token).not.toBe(created.token);
  expect(guest.board).toEqual({ id: active.id, title: active.title });
  expect(Object.keys(guest.session).sort()).toEqual(['boardId', 'expiresAt', 'id', 'role']);
  expect(guest.session.role).toBe('viewer');
  expect(await service.authorizeGuest(active.id, guest.token)).toEqual(guest.session);
  await expect(service.authorizeGuest(active.id, created.token)).rejects.toMatchObject({
    status: 404,
  });
  await expect(service.redeem(active.id, guest.token)).rejects.toMatchObject({ status: 404 });
  const other = await board();
  await expect(service.authorizeGuest(other.id, guest.token)).rejects.toMatchObject({
    status: 404,
  });
  await expect(service.redeem(other.id, created.token)).rejects.toMatchObject({ status: 404 });
  const [storedInvite] = await db.query<{ tokenDigest: string }>(
    'SELECT "tokenDigest" FROM board_invitations WHERE id=$1',
    [created.invite.id],
  );
  const [storedSession] = await db.query<{ tokenDigest: string }>(
    'SELECT "tokenDigest" FROM board_guest_sessions WHERE id=$1',
    [guest.session.id],
  );
  expect(storedInvite.tokenDigest).toBe(createHash('sha256').update(created.token).digest('hex'));
  expect(storedSession.tokenDigest).toBe(createHash('sha256').update(guest.token).digest('hex'));
  const values = JSON.stringify(await stored());
  expect(values).not.toContain(created.token);
  expect(values).not.toContain(guest.token);
  for (const metadata of [
    created.invite,
    await service.listInvites(ownerA, active.id),
    await service.list(ownerA),
    await service.get(ownerA, active.id),
  ]) {
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toMatch(/token|digest|invitationId/i);
  }
});
it('rejects CREATING guests and invitation creation until storage activation', async () => {
  const pending = await service.create(ownerA, { title: 'Incomplete', requestId: randomUUID() });
  await expect(
    service.createInvite(ownerA, pending.id, { role: 'viewer', ttlMinutes: 60, maxUses: 1 }),
  ).rejects.toMatchObject({ status: 409 });
  const before = await stored();
  await expect(service.redeem(pending.id, 'a'.repeat(64))).rejects.toMatchObject({ status: 404 });
  expect(await stored()).toEqual(before);
});
it('caps concurrent invitation redemption and preserves existing sessions after the cap', async () => {
  const active = await board();
  const invitation = await service.createInvite(ownerA, active.id, {
    role: 'editor',
    ttlMinutes: 60,
    maxUses: 2,
  });
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => service.redeem(active.id, invitation.token)),
  );
  const successes = results.filter((item) => item.status === 'fulfilled');
  expect(successes).toHaveLength(2);
  expect(results.filter((item) => item.status === 'rejected')).toHaveLength(6);
  expect((await service.listInvites(ownerA, active.id))[0].uses).toBe(2);
  for (const item of successes)
    if (item.status === 'fulfilled')
      expect((await service.authorizeGuest(active.id, item.value.token)).role).toBe('editor');
  expect(
    (
      await db.query('SELECT count(*)::int AS count FROM board_guest_sessions WHERE "boardId"=$1', [
        active.id,
      ])
    )[0].count,
  ).toBe(2);
});
it('rechecks session expiration on every authorization', async () => {
  const active = await board();
  const invitation = await service.createInvite(ownerA, active.id, {
    role: 'viewer',
    ttlMinutes: 60,
    maxUses: 1,
  });
  const guest = await service.redeem(active.id, invitation.token);
  await db.query(
    `UPDATE board_guest_sessions SET "createdAt"=now()-interval '2 hours',"expiresAt"=now()-interval '1 hour' WHERE id=$1`,
    [guest.session.id],
  );
  const before = await stored();
  await expect(service.authorizeGuest(active.id, guest.token)).rejects.toMatchObject({
    status: 404,
  });
  expect(await stored()).toEqual(before);
});
it('rechecks invitation expiration even when the guest session itself remains valid', async () => {
  const active = await board();
  const invitation = await service.createInvite(ownerA, active.id, {
    role: 'viewer',
    ttlMinutes: 60,
    maxUses: 2,
  });
  const guest = await service.redeem(active.id, invitation.token);
  await db.query(
    `UPDATE board_invitations SET "createdAt"=now()-interval '2 hours',"expiresAt"=now()-interval '1 hour' WHERE id=$1`,
    [invitation.invite.id],
  );
  const before = await stored();
  await expect(service.redeem(active.id, invitation.token)).rejects.toMatchObject({ status: 404 });
  await expect(service.authorizeGuest(active.id, guest.token)).rejects.toMatchObject({
    status: 404,
  });
  expect(await stored()).toEqual(before);
});
it('revokes an invitation and all existing sessions while leaving other invitations valid', async () => {
  const active = await board();
  const invitation = await service.createInvite(ownerA, active.id, {
    role: 'editor',
    ttlMinutes: 60,
    maxUses: 3,
  });
  const another = await service.createInvite(ownerA, active.id, {
    role: 'viewer',
    ttlMinutes: 60,
    maxUses: 1,
  });
  const guests = await Promise.all([
    service.redeem(active.id, invitation.token),
    service.redeem(active.id, invitation.token),
  ]);
  const unaffected = await service.redeem(active.id, another.token);
  await service.revokeInvite(ownerA, active.id, invitation.invite.id);
  await service.revokeInvite(ownerA, active.id, invitation.invite.id);
  for (const guest of guests)
    await expect(service.authorizeGuest(active.id, guest.token)).rejects.toMatchObject({
      status: 404,
    });
  await expect(service.redeem(active.id, invitation.token)).rejects.toMatchObject({ status: 404 });
  expect((await service.authorizeGuest(active.id, unaffected.token)).role).toBe('viewer');
  const sessions = await db.query(
    'SELECT "revokedAt" FROM board_guest_sessions WHERE "invitationId"=$1',
    [invitation.invite.id],
  );
  expect(sessions).toHaveLength(2);
  expect(sessions.every((item) => item.revokedAt)).toBe(true);
  const before = await stored();
  await expect(
    service.revokeInvite(ownerA, (await board()).id, invitation.invite.id),
  ).rejects.toMatchObject({ status: 404 });
  // A new board was created deliberately above; no invitation/session changed.
  const after = await stored();
  expect(after.board_invitations).toEqual(before.board_invitations);
  expect(after.board_guest_sessions).toEqual(before.board_guest_sessions);
});
it('rejects malformed tokens without mutation', async () => {
  const active = await board();
  const before = await stored();
  for (const token of ['', 'x'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64)]) {
    await expect(service.redeem(active.id, token)).rejects.toMatchObject({ status: 404 });
    await expect(service.authorizeGuest(active.id, token)).rejects.toMatchObject({ status: 404 });
  }
  expect(await stored()).toEqual(before);
});

it('refuses non-harness PostgreSQL targets without reflecting credentials', () => {
  for (const value of [
    'postgresql://tutorflow_pg_test:synthetic@db.example:55438/tutorflow_pg_harness_test',
    'postgresql://tutorflow_pg_test:synthetic@127.0.0.1:55438/tutorflow',
    'postgresql://other:synthetic@127.0.0.1:55438/tutorflow_pg_harness_test',
    'postgresql://tutorflow_pg_test:synthetic@127.0.0.1/tutorflow_pg_harness_test',
    'postgresql://tutorflow_pg_test:synthetic@127.0.0.1:55438/tutorflow_pg_harness_test?host=other',
    'postgresql://synthetic-secret@[invalid',
  ]) {
    let failure: unknown;
    try {
      harnessUrl(value);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toHaveProperty('input');
    expect(String(failure)).toBe(
      'Error: Board tests require a dedicated loopback synthetic PostgreSQL harness',
    );
  }
});

it('rejects whitespace-only and over-budget padded board titles in SQL', async () => {
  for (const title of ['\t\n', ' '.repeat(200) + 'x']) {
    await expect(
      db.query('INSERT INTO boards (id,"ownerId",title,"requestId") VALUES ($1,$2,$3,$4)', [
        randomUUID(),
        ownerA,
        title,
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  }
});

it('rechecks either revocation flag independently instead of relying on cascading service side effects', async () => {
  const active = await board();
  const invitation = await service.createInvite(ownerA, active.id, {
    role: 'viewer',
    ttlMinutes: 60,
    maxUses: 2,
  });
  const guest = await service.redeem(active.id, invitation.token);
  await db.query('UPDATE board_invitations SET "revokedAt"=clock_timestamp() WHERE id=$1', [
    invitation.invite.id,
  ]);
  await expect(service.authorizeGuest(active.id, guest.token)).rejects.toMatchObject({
    status: 404,
  });
  await db.query('UPDATE board_invitations SET "revokedAt"=NULL WHERE id=$1', [
    invitation.invite.id,
  ]);
  await db.query('UPDATE board_guest_sessions SET "revokedAt"=clock_timestamp() WHERE id=$1', [
    guest.session.id,
  ]);
  await expect(service.authorizeGuest(active.id, guest.token)).rejects.toMatchObject({
    status: 404,
  });
});

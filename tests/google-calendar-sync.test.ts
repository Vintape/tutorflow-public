import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrate, type Database } from '../server/db.js';
import {
  GoogleCalendarSyncError,
  countInitialGoogleCalendarLessons,
  enqueueGoogleCalendarLesson,
  enqueueInitialGoogleCalendarLessons,
  listGoogleCalendarSyncStates,
  processGoogleCalendarSync,
  resolveGoogleCalendarSync,
  type GoogleCalendarSyncEvent,
  type GoogleCalendarSyncPayload,
  type GoogleCalendarSyncTarget,
} from '../server/google-calendar/sync.js';

const initial = new Date('2099-01-01T00:00:00Z');
const startsAt = '2099-03-29T00:30:00.000Z';
const moved = '2099-03-29T23:45:00.000Z';
const latest = '2099-04-01T23:00:00.000Z';
const suppliedUrl = process.env.TUTORFLOW_TEST_DATABASE_URL;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function providers() {
  const events = new Map<string, GoogleCalendarSyncEvent>();
  const tombstones = new Set<string>();
  let revision = 0;
  let transportError: GoogleCalendarSyncError | undefined;
  let afterInsert: (() => Promise<void>) | undefined;
  let afterUpdate: (() => Promise<void>) | undefined;
  let beforeUpdate: (() => Promise<void>) | undefined;
  let afterRemove: (() => Promise<void>) | undefined;
  const store = (target: GoogleCalendarSyncTarget, payload: GoogleCalendarSyncPayload) => {
    const event = {
      ...payload,
      etag: `"etag-${++revision}"`,
      eventLink: `https://calendar.google.com/calendar/event?eid=${target.eventId}`,
    };
    events.set(target.eventId, event);
    return event;
  };
  const verify = (target: GoogleCalendarSyncTarget, etag: string) => {
    const event = events.get(target.eventId);
    if (!event) throw new GoogleCalendarSyncError('not_found');
    if (event.etag !== etag) throw new GoogleCalendarSyncError('precondition');
  };
  return {
    events,
    transport: {
      get: async (target: GoogleCalendarSyncTarget) => {
        if (transportError) throw transportError;
        return events.get(target.eventId) ?? null;
      },
      insert: async (target: GoogleCalendarSyncTarget, payload: GoogleCalendarSyncPayload) => {
        if (events.has(target.eventId) || tombstones.has(target.eventId))
          throw new GoogleCalendarSyncError('conflict');
        expect(target.eventId).toMatch(/^[0-9a-v]{5,1024}$/);
        const event = store(target, payload);
        await afterInsert?.();
        return event;
      },
      update: async (
        target: GoogleCalendarSyncTarget,
        payload: GoogleCalendarSyncPayload,
        etag: string,
      ) => {
        await beforeUpdate?.();
        verify(target, etag);
        const event = store(target, payload);
        await afterUpdate?.();
        return event;
      },
      remove: async (target: GoogleCalendarSyncTarget, etag: string) => {
        verify(target, etag);
        events.delete(target.eventId);
        tombstones.add(target.eventId);
        await afterRemove?.();
      },
    },
    failWith: (error?: GoogleCalendarSyncError) => (transportError = error),
    afterInsert: (fn: () => Promise<void>) => (afterInsert = fn),
    afterUpdate: (fn: () => Promise<void>) => (afterUpdate = fn),
    beforeUpdate: (fn: () => Promise<void>) => (beforeUpdate = fn),
    afterRemove: (fn: () => Promise<void>) => (afterRemove = fn),
    manuallyDelete: (id: string) => {
      events.delete(id);
      tombstones.add(id);
    },
  };
}

function isolatedDatabaseUrl(value: string) {
  const refused = new Error('Calendar tests require the dedicated loopback synthetic harness');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw refused;
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    !url.port ||
    !!url.search ||
    url.username !== 'tutorflow_pg_test' ||
    !/^\/tutorflow_pg_harness_[a-zA-Z0-9_]+$/.test(url.pathname)
  )
    throw refused;
  return url;
}

function suite(adapter: 'PGlite' | 'PostgreSQL', skip = false) {
  describe.skipIf(skip)(`durable Google Calendar queue on ${adapter}`, () => {
    let db: Database;
    let admin: pg.Client | undefined;
    let databaseCreated = false;
    const databaseName = `tutorflow_calendar_${randomUUID().replaceAll('-', '')}`;
    beforeAll(async () => {
      if (adapter === 'PostgreSQL' && suppliedUrl) {
        const url = isolatedDatabaseUrl(suppliedUrl);
        admin = new pg.Client({ connectionString: url.toString() });
        await admin.connect();
        await admin.query(`CREATE DATABASE "${databaseName}"`);
        databaseCreated = true;
        url.pathname = `/${databaseName}`;
        db = await createDatabase({ dataDir: 'memory://', databaseUrl: url.toString() });
      } else db = await createDatabase({ dataDir: 'memory://' });
      await migrate(db);
    });

    beforeEach(() => db.query('DELETE FROM "user"'));

    afterAll(async () => {
      try {
        await db?.close();
        if (databaseCreated) await admin?.query(`DROP DATABASE "${databaseName}"`);
      } finally {
        await admin?.end();
      }
    });

    async function fixture(status = 'connected') {
      const ownerId = randomUUID();
      const studentId = randomUUID();
      const connectionId = randomUUID();
      const calendarId = `calendar-${connectionId}`;
      await db.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', [
        ownerId,
        'Synthetic owner',
        `${ownerId}@example.test`,
      ]);
      await db.query(
        `INSERT INTO students (id, "ownerId", name, subject, price, duration)
         VALUES ($1, $2, 'Synthetic student', 'Subject', 0, 90)`,
        [studentId, ownerId],
      );
      await db.query(
        `INSERT INTO google_calendar_connections
         (id, "ownerId", "googleSubject", "calendarId", "refreshCiphertext", status)
         VALUES ($1, $2, $3, $4, 'synthetic-ciphertext', $5)`,
        [connectionId, ownerId, connectionId, calendarId, status],
      );
      const insert = async (date = startsAt, lessonStatus = 'PLANNED', enqueue = true) => {
        const id = randomUUID();
        await db.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO lessons (id, "ownerId", "studentId", "startsAt", duration, price, topic, status)
             VALUES ($1, $2, $3, $4, 90, 12000, 'Synthetic private topic', $5)`,
            [id, ownerId, studentId, date, lessonStatus],
          );
          if (enqueue) await enqueueGoogleCalendarLesson(tx, ownerId, id);
        });
        return id;
      };
      const change = async (id: string, status: string, date = startsAt) => {
        await db.transaction(async (tx) => {
          await tx.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [ownerId]);
          await tx.query(
            `UPDATE lessons SET "startsAt" = $3, status = $4, version = version + 1
             WHERE "ownerId" = $1 AND id = $2`,
            [ownerId, id, date, status],
          );
          await enqueueGoogleCalendarLesson(tx, ownerId, id);
        });
      };
      const mock = providers();
      const process = (minutes = 0, limit = 20) =>
        processGoogleCalendarSync(db, mock.transport, {
          limit,
          now: new Date(initial.getTime() + minutes * 60_000),
        });
      const state = async (id: string) =>
        (await listGoogleCalendarSyncStates(db, ownerId)).find((entry) => entry.lessonId === id);
      return { ownerId, connectionId, calendarId, insert, change, state, mock, process };
    }

    it('publishes UTC time and a generic payload after the lesson transaction commits', async () => {
      const f = await fixture();
      const lesson = await f.insert();
      expect(await f.state(lesson)).toMatchObject({ status: 'pending', eventLink: null });
      await f.process();
      const [event] = f.mock.events.values();
      expect(event).toEqual({
        summary: 'Занятие TutorFlow',
        startsAt: '2099-03-29T00:30:00.000Z',
        endsAt: '2099-03-29T02:00:00.000Z',
        marker: expect.stringMatching(/^[0-9a-v]+:1$/),
        etag: expect.any(String),
        eventLink: expect.stringContaining('https://calendar.google.com/'),
      });
      expect(await f.state(lesson)).toMatchObject({ status: 'synced', eventLink: event.eventLink });
    });

    it('reconciles a lost insert response and publishes only the newest desired schedule', async () => {
      const f = await fixture();
      const lesson = await f.insert();
      f.mock.afterInsert(async () => {
        await f.change(lesson, 'PLANNED', moved);
        await f.change(lesson, 'PLANNED', latest);
        throw new Error('private provider response');
      });
      await f.process();
      const [eventId] = f.mock.events.keys();
      expect(await f.state(lesson)).toMatchObject({ status: 'pending' });
      await f.process(60);
      expect([...f.mock.events.keys()]).toEqual([eventId]);
      expect(f.mock.events.get(eventId)).toMatchObject({
        startsAt: latest,
        endsAt: '2099-04-02T00:30:00.000Z',
      });
      expect(await f.state(lesson)).toMatchObject({ status: 'synced' });
    });

    it.each([false, true])(
      'recreates the same event ID from an earlier local snapshot (remote edited: %s)',
      async (edited) => {
        const f = await fixture();
        const lesson = await f.insert();
        await f.process();
        const [id, event] = [...f.mock.events.entries()][0]!;
        if (edited) f.mock.events.set(id, { ...event, startsAt: moved, etag: '"manual-restored"' });
        await db.query(
          'DELETE FROM google_calendar_sync WHERE "ownerId" = $1 AND "lessonId" = $2',
          [f.ownerId, lesson],
        );
        await db.transaction((tx) => enqueueInitialGoogleCalendarLessons(tx, f.ownerId, initial));
        await f.process();
        expect([...f.mock.events.keys()]).toEqual([id]);
        expect(f.mock.events.get(id)?.startsAt).toBe(edited ? moved : startsAt);
        expect(await f.state(lesson)).toMatchObject(
          edited
            ? { status: 'needs_review', reason: 'remote_changed' }
            : { status: 'synced', eventLink: event.eventLink },
        );
      },
    );

    it('does not clear a newer desired version when an older write completes', async () => {
      const f = await fixture();
      const lesson = await f.insert();
      f.mock.afterInsert(async () => {
        await f.change(lesson, 'PLANNED', latest);
        expect(await f.process(0, 1)).toBe(0);
      });
      await f.process(0, 1);
      expect(await f.state(lesson)).toMatchObject({ status: 'pending' });
      await f.process();
      expect(f.mock.events.size).toBe(1);
      expect([...f.mock.events.values()][0]?.startsAt).toBe(latest);
    });

    it('recovers a durable candidate after a worker lease expires and fences its late acknowledgement', async () => {
      const f = await fixture();
      const lesson = await f.insert();
      const committed = deferred();
      const acknowledge = deferred();
      f.mock.afterInsert(async () => {
        committed.resolve();
        await acknowledge.promise;
      });
      const stalled = f.process(0, 1);
      try {
        await committed.promise;
        const [id] = f.mock.events.keys();
        await f.change(lesson, 'PLANNED', latest);
        expect(await f.process(4)).toBe(0);
        await f.process(5);
        expect(await f.state(lesson)).toMatchObject({ status: 'synced' });
        expect(f.mock.events.size).toBe(1);
        expect(f.mock.events.get(id)?.startsAt).toBe(latest);
      } finally {
        acknowledge.resolve();
        await stalled;
      }
      expect(await f.process(6)).toBe(0);
      expect(await f.state(lesson)).toMatchObject({ status: 'synced' });
    });

    it('reconciles a lost update response without overwriting a later manual move', async () => {
      const f = await fixture();
      const lesson = await f.insert();
      await f.process();
      const [id] = f.mock.events.keys();
      f.mock.afterUpdate(async () => {
        const event = f.mock.events.get(id)!;
        f.mock.events.set(id, { ...event, startsAt: latest, etag: '"manual-change"' });
        throw new Error('unknown result');
      });
      await f.change(lesson, 'PLANNED', moved);
      await f.process();
      await f.process(60);
      expect(await f.state(lesson)).toMatchObject({
        status: 'needs_review',
        reason: 'remote_changed',
      });
      expect(f.mock.events.get(id)?.startsAt).toBe(latest);
    });

    it('does not delete completed lessons and uses a fresh event ID after cancellation and restoration', async () => {
      const f = await fixture();
      const lesson = await f.insert();
      await f.process();
      const [firstId] = f.mock.events.keys();
      await f.change(lesson, 'COMPLETED');
      await f.process();
      expect(f.mock.events.has(firstId)).toBe(true);
      await f.change(lesson, 'CANCELLED');
      await f.change(lesson, 'PLANNED', moved);
      let loss = true;
      f.mock.afterRemove(async () => {
        if (loss) throw new Error('lost deletion response');
      });
      await f.process();
      loss = false;
      expect(f.mock.events.size).toBe(0);
      await f.process(60);
      expect(f.mock.events.size).toBe(1);
      expect(f.mock.events.has(firstId)).toBe(false);
      expect([...f.mock.events.values()][0]?.startsAt).toBe(moved);
      expect(await f.state(lesson)).toMatchObject({ status: 'synced' });
    });

    it('leaves a manually changed event untouched until the owner explicitly restores it', async () => {
      const f = await fixture();
      const lesson = await f.insert();
      await f.process();
      const [id, event] = [...f.mock.events.entries()][0]!;
      f.mock.events.set(id, { ...event, summary: 'Manual', etag: '"manual-change"' });
      await f.change(lesson, 'PLANNED', moved);
      await f.process();
      expect(await f.state(lesson)).toMatchObject({
        status: 'needs_review',
        reason: 'remote_changed',
      });
      expect(f.mock.events.get(id)?.summary).toBe('Manual');
      expect(await resolveGoogleCalendarSync(db, 'unknown-owner', lesson, 'restore')).toBe(false);
      expect(await resolveGoogleCalendarSync(db, f.ownerId, lesson, 'restore')).toBe(true);
      await f.process();
      expect(f.mock.events.size).toBe(1);
      expect(f.mock.events.get(id)?.summary).toBe('Занятие TutorFlow');
      expect(f.mock.events.get(id)?.startsAt).toBe(moved);
    });

    it('leaves edits made between reading an event and writing it untouched after a 412', async () => {
      const f = await fixture();
      const lesson = await f.insert();
      await f.process();
      const [id, event] = [...f.mock.events.entries()][0]!;
      f.mock.beforeUpdate(async () => {
        f.mock.events.set(id, { ...event, summary: 'Changed concurrently', etag: '"manual-race"' });
      });
      await f.change(lesson, 'PLANNED', moved);
      await f.process();
      expect(await f.state(lesson)).toMatchObject({
        status: 'needs_review',
        reason: 'remote_changed',
      });
      expect(f.mock.events.get(id)?.summary).toBe('Changed concurrently');
      expect(await resolveGoogleCalendarSync(db, f.ownerId, lesson, 'keep')).toBe(true);
      await f.change(lesson, 'PLANNED', latest);
      await f.process();
      expect(await f.state(lesson)).toBeUndefined();
      expect(f.mock.events.get(id)?.summary).toBe('Changed concurrently');
    });

    it('does not publish a second generation after the owner keeps a conflicting Google copy', async () => {
      const f = await fixture();
      const lesson = await f.insert();
      await f.process();
      const [id, event] = [...f.mock.events.entries()][0]!;
      f.mock.events.set(id, { ...event, summary: 'Manual', etag: '"manual-kept"' });
      await f.change(lesson, 'CANCELLED');
      await f.change(lesson, 'PLANNED', moved);
      await f.process();
      expect(await f.state(lesson)).toMatchObject({ status: 'needs_review' });
      expect(await resolveGoogleCalendarSync(db, f.ownerId, lesson, 'keep')).toBe(true);
      await f.process();
      expect(f.mock.events.size).toBe(1);
      expect(f.mock.events.get(id)?.summary).toBe('Manual');
      expect(await f.state(lesson)).toBeUndefined();
    });

    it('gives an explicitly restored manually deleted event a new ID', async () => {
      const f = await fixture();
      const lesson = await f.insert();
      await f.process();
      const [id] = f.mock.events.keys();
      f.mock.manuallyDelete(id);
      await f.change(lesson, 'PLANNED', moved);
      await f.process();
      expect(await f.state(lesson)).toMatchObject({
        status: 'needs_review',
        reason: 'remote_missing',
      });
      expect(f.mock.events.size).toBe(0);
      expect(await resolveGoogleCalendarSync(db, f.ownerId, lesson, 'restore')).toBe(true);
      await f.process();
      expect(f.mock.events.size).toBe(1);
      expect(f.mock.events.has(id)).toBe(false);
    });

    it('leaves events with missing ownership markers untouched even after explicit restore', async () => {
      const f = await fixture();
      const lesson = await f.insert();
      await f.process();
      const [id, event] = [...f.mock.events.entries()][0]!;
      f.mock.events.set(id, { ...event, marker: null, etag: '"manual-unlinked"' });
      await f.change(lesson, 'CANCELLED');
      await f.process();
      expect(await f.state(lesson)).toMatchObject({
        status: 'needs_review',
        reason: 'ownership_mismatch',
      });
      expect(await resolveGoogleCalendarSync(db, f.ownerId, lesson, 'restore')).toBe(true);
      await f.process();
      expect(f.mock.events.get(id)?.etag).toBe('"manual-unlinked"');
      expect(await f.state(lesson)).toMatchObject({ status: 'needs_review' });
    });

    it('preserves manually added content when explicitly restoring a copy would remove it', async () => {
      const f = await fixture();
      const lesson = await f.insert();
      await f.process();
      const [id, event] = [...f.mock.events.entries()][0]!;
      f.mock.events.set(id, { ...event, hasUnexpectedContent: true, etag: '"manual-attendees"' });
      await f.change(lesson, 'PLANNED', moved);
      await f.process();
      expect(await resolveGoogleCalendarSync(db, f.ownerId, lesson, 'restore')).toBe(true);
      await f.process();
      expect(f.mock.events.get(id)?.etag).toBe('"manual-attendees"');
      expect(await f.state(lesson)).toMatchObject({
        status: 'needs_review',
        reason: 'remote_changed',
      });
    });

    it('defers retries using Retry-After and stops after five temporary failures', async () => {
      const f = await fixture();
      const lesson = await f.insert();
      f.mock.failWith(new GoogleCalendarSyncError('retry', 120_000));
      await f.process(0);
      expect(await f.process(1)).toBe(0);
      for (const min of [2, 4, 6, 8]) expect(await f.process(min)).toBe(1);
      expect(await f.process(180)).toBe(0);
      expect(await f.state(lesson)).toMatchObject({
        status: 'needs_review',
        reason: 'retry_exhausted',
      });
      await resolveGoogleCalendarSync(db, f.ownerId, lesson, 'keep');
    });

    it('pauses all queued work on revoked access and resumes it after reconnecting', async () => {
      const f = await fixture();
      const first = await f.insert();
      const second = await f.insert();
      f.mock.failWith(new GoogleCalendarSyncError('reconnect'));
      expect(await f.process()).toBe(1);
      expect(await f.state(first)).toMatchObject({ status: 'reconnect' });
      expect(await f.state(second)).toMatchObject({ status: 'reconnect' });
      f.mock.failWith();
      expect(await f.process(60)).toBe(0);
      await db.query(
        'UPDATE google_calendar_connections SET status=\'connected\' WHERE "ownerId" = $1',
        [f.ownerId],
      );
      await f.process(60);
      expect(f.mock.events.size).toBe(2);
    });

    it('reconciles only eligible lessons when an owner confirms publication after disconnecting', async () => {
      const f = await fixture();
      const published = await f.insert();
      const kept = await f.insert(moved);
      await f.process();
      const originalId = [...f.mock.events].find(([, event]) => event.startsAt === startsAt)?.[0];
      const keptId = [...f.mock.events].find(([, event]) => event.startsAt === moved)?.[0];
      const cancelled = await f.insert();
      await db.query(
        `UPDATE google_calendar_connections SET status = 'disconnected' WHERE "ownerId" = $1`,
        [f.ownerId],
      );
      await f.change(published, 'PLANNED', latest);
      await f.change(cancelled, 'CANCELLED');
      await f.change(kept, 'CANCELLED');
      expect(await countInitialGoogleCalendarLessons(db, f.ownerId, initial)).toBe(1);
      await db.query(
        `UPDATE google_calendar_connections SET status = 'connected' WHERE "ownerId" = $1`,
        [f.ownerId],
      );
      expect(
        await db.transaction((tx) => enqueueInitialGoogleCalendarLessons(tx, f.ownerId, initial)),
      ).toBe(1);
      await f.process();
      expect([...f.mock.events.keys()]).toEqual(expect.arrayContaining([originalId, keptId]));
      expect(f.mock.events.size).toBe(2);
      expect(f.mock.events.get(originalId!)?.startsAt).toBe(latest);
      expect(f.mock.events.get(keptId!)?.startsAt).toBe(moved);
      expect(await f.state(kept)).toMatchObject({
        status: 'needs_review',
        reason: 'offline_cancellation',
        eventLink: null,
      });
      expect(await f.state(cancelled)).toBeUndefined();
    });

    it.each([false, true])(
      'requires explicit cleanup of an offline cancellation and preserves manual edits (edited: %s)',
      async (edited) => {
        const f = await fixture();
        const lesson = await f.insert();
        await f.process();
        const [id, event] = [...f.mock.events.entries()][0]!;
        await db.query(
          `UPDATE google_calendar_connections SET status = 'disconnected' WHERE "ownerId" = $1`,
          [f.ownerId],
        );
        await f.change(lesson, 'CANCELLED');
        await db.transaction(async (tx) => {
          await tx.query(
            `UPDATE google_calendar_connections SET status = 'connected' WHERE "ownerId" = $1`,
            [f.ownerId],
          );
          await enqueueInitialGoogleCalendarLessons(tx, f.ownerId, initial);
        });
        expect(await f.process()).toBe(0);
        expect(f.mock.events.has(id)).toBe(true);
        if (edited) f.mock.events.set(id, { ...event, etag: '"manually-edited"' });
        expect(await resolveGoogleCalendarSync(db, f.ownerId, lesson, 'restore')).toBe(true);
        await f.process();
        expect(f.mock.events.has(id)).toBe(edited);
        expect(await f.state(lesson)).toMatchObject(
          edited
            ? { status: 'needs_review', reason: 'remote_changed' }
            : { status: 'synced', eventLink: null },
        );
      },
    );

    it('enqueues only own future planned lessons during first publication', async () => {
      const f = await fixture();
      const foreign = await fixture();
      const eligible = await f.insert(startsAt, 'PLANNED', false);
      const past = await f.insert('2020-02-01T00:00:00Z', 'PLANNED', false);
      const cancelled = await f.insert(startsAt, 'CANCELLED', false);
      const completed = await f.insert(startsAt, 'COMPLETED', false);
      const foreignLesson = await foreign.insert(startsAt, 'PLANNED', false);
      expect(await countInitialGoogleCalendarLessons(db, f.ownerId, initial)).toBe(1);
      expect(
        await db.transaction((tx) => enqueueInitialGoogleCalendarLessons(tx, f.ownerId, initial)),
      ).toBe(1);
      expect(
        await db.transaction((tx) => enqueueInitialGoogleCalendarLessons(tx, f.ownerId, initial)),
      ).toBe(0);
      expect(await f.state(eligible)).toMatchObject({ status: 'pending' });
      expect(await f.state(past)).toBeUndefined();
      expect(await f.state(cancelled)).toBeUndefined();
      expect(await f.state(completed)).toBeUndefined();
      expect(await foreign.state(foreignLesson)).toBeUndefined();
    });
  });
}

suite('PGlite');
suite('PostgreSQL', !suppliedUrl);

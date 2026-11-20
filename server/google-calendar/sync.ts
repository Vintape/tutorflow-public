import { randomUUID } from 'node:crypto';
import type { Database, SQL } from '../db.js';

const title = 'Занятие TutorFlow';
const maxAttempts = 5;
const leaseMs = 5 * 60_000;

export interface GoogleCalendarSyncTarget {
  ownerId: string;
  connectionId: string;
  calendarId: string;
  eventId: string;
}

export interface GoogleCalendarSyncPayload {
  summary: typeof title;
  startsAt: string;
  endsAt: string;
  marker: string;
}

export interface GoogleCalendarSyncEvent {
  etag: string;
  eventLink: string | null;
  marker: string | null;
  summary: string | null;
  startsAt: string | null;
  endsAt: string | null;
  hasUnexpectedContent?: boolean;
}

export interface GoogleCalendarSyncTransport {
  // Each request must time out well within the queue's five-minute lease.
  get(target: GoogleCalendarSyncTarget): Promise<GoogleCalendarSyncEvent | null>;
  insert(
    target: GoogleCalendarSyncTarget,
    payload: GoogleCalendarSyncPayload,
  ): Promise<GoogleCalendarSyncEvent>;
  update(
    target: GoogleCalendarSyncTarget,
    payload: GoogleCalendarSyncPayload,
    etag: string,
  ): Promise<GoogleCalendarSyncEvent>;
  remove(target: GoogleCalendarSyncTarget, etag: string): Promise<void>;
}

type TransportError = 'retry' | 'reconnect' | 'conflict' | 'not_found' | 'precondition' | 'invalid';

export class GoogleCalendarSyncError extends Error {
  constructor(
    readonly kind: TransportError,
    readonly retryAfterMs?: number,
  ) {
    super(kind);
    this.name = 'GoogleCalendarSyncError';
  }
}

type ReviewReason =
  | 'remote_changed'
  | 'remote_missing'
  | 'ownership_mismatch'
  | 'provider_rejected'
  | 'retry_exhausted'
  | 'offline_cancellation';

export interface GoogleCalendarSyncState {
  lessonId: string;
  status: 'pending' | 'synced' | 'needs_review' | 'reconnect';
  eventLink: string | null;
  reason: ReviewReason | 'connection_unavailable' | null;
}

type Action = 'upsert' | 'delete';
type Candidate =
  | { operation: 'insert'; version: number; payload: GoogleCalendarSyncPayload }
  | { operation: 'update'; version: number; payload: GoogleCalendarSyncPayload; etag: string }
  | { operation: 'delete'; version: number; etag: string };

interface ClaimedJob extends GoogleCalendarSyncTarget {
  lessonId: string;
  generation: number;
  leaseToken: string;
  connectionVersion: string;
  desiredVersion: number;
  desiredAction: Action;
  startsAt: string;
  duration: number;
  etag: string | null;
  appliedVersion: number | null;
  candidate: Candidate | null;
  restoreRequested: boolean;
}

const eligibleLessons = `FROM lessons l
  WHERE l."ownerId" = $1 AND l.status = 'PLANNED' AND l."startsAt" >= $2::timestamptz`;

const latestGeneration = `LEFT JOIN LATERAL (
  SELECT q.generation, q."desiredAction", q.state FROM google_calendar_sync q
  WHERE q."ownerId" = c."ownerId" AND q."connectionId" = c.id AND q."lessonId" = l.id
  ORDER BY q.generation DESC LIMIT 1
) latest ON true`;

const schedulePending = `state = CASE WHEN q.state IN ('synced', 'paused') THEN 'pending' ELSE q.state END,
  attempts = CASE WHEN q.candidate IS NULL THEN 0 ELSE q.attempts END,
  "nextAttemptAt" = CASE WHEN q.candidate IS NULL OR q.state = 'paused' THEN now() ELSE q."nextAttemptAt" END`;

function stableEventId(connection: string, lesson: string, generation: string) {
  // JSON encodes the boundaries unambiguously even for non-UUID migrated IDs.
  return `encode(sha256(convert_to(json_build_array(${connection}, ${lesson}, ${generation})::text, 'UTF8')), 'hex')`;
}

export async function countInitialGoogleCalendarLessons(
  db: SQL,
  ownerId: string,
  now = new Date(),
): Promise<number> {
  const [row] = await db.query<{ count: number }>(
    `SELECT count(*)::integer AS count ${eligibleLessons}`,
    [ownerId, now.toISOString()],
  );
  return row?.count ?? 0;
}

export async function enqueueInitialGoogleCalendarLessons(
  tx: SQL,
  ownerId: string,
  now = new Date(),
): Promise<number> {
  await tx.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [ownerId]);
  const [result] = await tx.query<{ count: number }>(
    `WITH active_connection AS (
       SELECT "ownerId", id FROM google_calendar_connections
       WHERE "ownerId" = $1 AND status = 'connected'
         AND "calendarId" IS NOT NULL AND "refreshCiphertext" IS NOT NULL
     ),
     eligible AS (
       SELECT l.id, l."ownerId", l."startsAt", l.duration, l.version, c.id AS "connectionId",
              latest.generation, latest."desiredAction", latest.state
       FROM (SELECT l.id, l."ownerId", l."startsAt", l.duration, l.version ${eligibleLessons}) l
       JOIN active_connection c ON c."ownerId" = l."ownerId"
       ${latestGeneration}
     ),
     offline_cancellations AS (
       UPDATE google_calendar_sync q
       SET state = 'needs_review', reason = COALESCE(q.reason, 'offline_cancellation'),
           "desiredAction" = 'delete', "desiredVersion" = l.version,
           "leaseToken" = NULL, "leaseUntil" = NULL
       FROM active_connection c JOIN lessons l ON l."ownerId" = c."ownerId"
       WHERE q."ownerId" = c."ownerId" AND q."connectionId" = c.id AND q."lessonId" = l.id
         AND l.status = 'CANCELLED' AND q."desiredAction" = 'upsert' AND q.state <> 'dismissed'
         AND (q.etag IS NOT NULL OR q.state = 'needs_review')
     ),
     outside_snapshot AS (
       UPDATE google_calendar_sync q SET state = 'paused', "leaseToken" = NULL, "leaseUntil" = NULL
       FROM active_connection c JOIN lessons l ON l."ownerId" = c."ownerId"
       WHERE q."ownerId" = c."ownerId" AND q."connectionId" = c.id AND q."lessonId" = l.id
         AND q.state = 'pending' AND q."desiredAction" = 'upsert'
         AND NOT (l.status = 'CANCELLED' AND q.etag IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM eligible e WHERE e.id = q."lessonId")
     ),
     refreshed AS (
       UPDATE google_calendar_sync q
       SET "desiredVersion" = e.version, "startsAt" = e."startsAt", duration = e.duration,
           ${schedulePending}
       FROM eligible e
       WHERE q."ownerId" = e."ownerId" AND q."connectionId" = e."connectionId"
         AND q."lessonId" = e.id AND q.generation = e.generation
         AND e."desiredAction" = 'upsert' AND q.state <> 'dismissed'
         AND (q.state = 'paused' OR q."startsAt" <> e."startsAt" OR q.duration <> e.duration)
       RETURNING 1
     ),
     inserted AS (
       INSERT INTO google_calendar_sync
         ("ownerId", "connectionId", "lessonId", generation, "eventId",
          "desiredAction", "desiredVersion", "startsAt", duration)
       SELECT e."ownerId", e."connectionId", e.id, COALESCE(e.generation, 0) + 1,
              ${stableEventId('e."connectionId"', 'e.id', 'COALESCE(e.generation, 0) + 1')},
              'upsert', e.version, e."startsAt", e.duration
       FROM eligible e
       WHERE e.generation IS NULL OR (e."desiredAction" = 'delete' AND e.state <> 'dismissed')
       RETURNING 1
     )
     SELECT ((SELECT count(*) FROM refreshed) + (SELECT count(*) FROM inserted))::integer AS count`,
    [ownerId, now.toISOString()],
  );
  return result?.count ?? 0;
}

export async function enqueueGoogleCalendarLesson(
  tx: SQL,
  ownerId: string,
  lessonId: string,
): Promise<void> {
  // TutorService takes this lock before changing lessons. The snapshot takes it too.
  await tx.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [ownerId]);
  const [row] = await tx.query<{
    connectionId: string;
    version: number;
    startsAt: string;
    duration: number;
    status: 'PLANNED' | 'COMPLETED' | 'CANCELLED';
    future: boolean;
    generation: number | null;
    desiredAction: Action | null;
    state: string | null;
  }>(
    `SELECT c.id AS "connectionId", l.version, l."startsAt", l.duration, l.status,
            l."startsAt" >= now() AS future, latest.generation, latest."desiredAction", latest.state
     FROM google_calendar_connections c
     JOIN lessons l ON l."ownerId" = c."ownerId"
     ${latestGeneration}
     WHERE c."ownerId" = $1 AND l.id = $2 AND c.status IN ('connected', 'needs_reconnect')
       AND c."calendarId" IS NOT NULL`,
    [ownerId, lessonId],
  );
  if (!row || row.state === 'dismissed') return;
  const action = row.status === 'CANCELLED' ? 'delete' : 'upsert';
  const newGeneration =
    row.generation === null || (row.desiredAction === 'delete' && action === 'upsert');
  if (newGeneration) {
    if (row.status !== 'PLANNED' || !row.future) return;
    await tx.query(
      `INSERT INTO google_calendar_sync
       ("ownerId", "connectionId", "lessonId", generation, "eventId",
        "desiredAction", "desiredVersion", "startsAt", duration)
       VALUES ($1, $2, $3, $4, ${stableEventId('$2::text', '$3::text', '$4::integer')},
               'upsert', $5, $6, $7)`,
      [
        ownerId,
        row.connectionId,
        lessonId,
        (row.generation ?? 0) + 1,
        row.version,
        row.startsAt,
        row.duration,
      ],
    );
    return;
  }

  if (row.state === 'paused' && row.status === 'COMPLETED') return;
  await tx.query(
    `UPDATE google_calendar_sync q
     SET "desiredAction" = $5, "desiredVersion" = $6, "startsAt" = $7, duration = $8,
         ${schedulePending}
     WHERE q."ownerId" = $1 AND q."connectionId" = $2 AND q."lessonId" = $3 AND q.generation = $4
       AND (q.state = 'paused' OR q."desiredAction" <> $5 OR
            ($5 = 'upsert' AND (q."startsAt" <> $7 OR q.duration <> $8)))`,
    [
      ownerId,
      row.connectionId,
      lessonId,
      row.generation,
      action,
      row.version,
      row.startsAt,
      row.duration,
    ],
  );
}

export async function listGoogleCalendarSyncStates(
  db: SQL,
  ownerId: string,
  lessonId?: string,
): Promise<GoogleCalendarSyncState[]> {
  return db.query<GoogleCalendarSyncState>(
    `SELECT "lessonId",
            CASE WHEN unavailable THEN 'reconnect' ELSE state END AS status,
            CASE WHEN state = 'synced' AND NOT unavailable THEN "eventLink" ELSE NULL END AS "eventLink",
            CASE WHEN unavailable THEN 'connection_unavailable' ELSE reason END AS reason
     FROM (
       SELECT DISTINCT ON (q."lessonId")
         q."lessonId", q.state, q."eventLink", q.reason, l."updatedAt",
         c.status <> 'connected' OR c."refreshCiphertext" IS NULL AS unavailable
       FROM google_calendar_sync q
       JOIN google_calendar_connections c ON c."ownerId" = q."ownerId" AND c.id = q."connectionId"
       JOIN lessons l ON l."ownerId" = q."ownerId" AND l.id = q."lessonId"
       WHERE q."ownerId" = $1 AND ($2::text IS NULL OR q."lessonId" = $2)
       ORDER BY q."lessonId", (q.state = 'needs_review') DESC, q.generation DESC
     ) visible WHERE state NOT IN ('dismissed', 'paused')
     ORDER BY "updatedAt" DESC, "lessonId" LIMIT 200`,
    [ownerId, lessonId ?? null],
  );
}

export async function resolveGoogleCalendarSync(
  db: Database,
  ownerId: string,
  lessonId: string,
  resolution: 'keep' | 'restore',
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [ownerId]);
    const [row] = await tx.query<{ connectionId: string; generation: number }>(
      `WITH conflict AS (
         SELECT "connectionId", generation FROM google_calendar_sync
         WHERE "ownerId" = $1 AND "lessonId" = $2 AND state = 'needs_review'
         ORDER BY generation LIMIT 1
       )
       UPDATE google_calendar_sync q
       SET state = $3, candidate = NULL,
           "restoreRequested" = $4 AND q.reason IS DISTINCT FROM 'offline_cancellation',
           attempts = 0, reason = NULL, "nextAttemptAt" = now()
       FROM conflict
       WHERE q."ownerId" = $1 AND q."lessonId" = $2
         AND q."connectionId" = conflict."connectionId" AND q.generation = conflict.generation
         AND q.state = 'needs_review'
       RETURNING q."connectionId", q.generation`,
      [
        ownerId,
        lessonId,
        resolution === 'keep' ? 'dismissed' : 'pending',
        resolution === 'restore',
      ],
    );
    if (row && resolution === 'keep') {
      // Keeping the manual copy also cancels any later, still-unpublished generation.
      await tx.query(
        `UPDATE google_calendar_sync SET state = 'dismissed'
         WHERE "ownerId" = $1 AND "lessonId" = $2 AND "connectionId" = $3 AND generation > $4
           AND state IN ('pending', 'paused')`,
        [ownerId, lessonId, row.connectionId, row.generation],
      );
    }
    return !!row;
  });
}

async function claim(db: SQL, now: Date): Promise<ClaimedJob | undefined> {
  const [row] = await db.query<ClaimedJob>(
    `WITH ready AS (
       SELECT q."ownerId", q."connectionId", q."lessonId", q.generation,
              c."calendarId", c."updatedAt"::text AS "connectionVersion"
       FROM google_calendar_sync q
       JOIN google_calendar_connections c ON c."ownerId" = q."ownerId" AND c.id = q."connectionId"
       WHERE q.state = 'pending' AND q."nextAttemptAt" <= $1
         AND (q."leaseUntil" IS NULL OR q."leaseUntil" <= $1)
         AND c.status = 'connected' AND c."calendarId" IS NOT NULL AND c."refreshCiphertext" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM google_calendar_sync older
           WHERE older."ownerId" = q."ownerId" AND older."connectionId" = q."connectionId"
             AND older."lessonId" = q."lessonId" AND older.generation < q.generation
             AND older.state IN ('pending', 'needs_review')
         )
       ORDER BY q."nextAttemptAt", q."eventId" LIMIT 1 FOR UPDATE OF q SKIP LOCKED
     )
     UPDATE google_calendar_sync q SET "leaseToken" = $2, "leaseUntil" = $3
     FROM ready WHERE q."ownerId" = ready."ownerId" AND q."connectionId" = ready."connectionId"
       AND q."lessonId" = ready."lessonId" AND q.generation = ready.generation
     RETURNING q.*, ready."calendarId", ready."connectionVersion"`,
    [now.toISOString(), randomUUID(), new Date(now.getTime() + leaseMs).toISOString()],
  );
  return row;
}

const ownedClaim = `"ownerId" = $1 AND "connectionId" = $2 AND "lessonId" = $3
  AND generation = $4 AND "leaseToken" = $5`;

function claimParams(job: ClaimedJob) {
  return [job.ownerId, job.connectionId, job.lessonId, job.generation, job.leaseToken];
}

function safeEventLink(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      ['calendar.google.com', 'www.google.com'].includes(url.hostname) &&
      url.pathname.startsWith('/calendar/') &&
      !url.username &&
      !url.password &&
      !url.port
    )
      return url.toString();
  } catch {
    // Ignore invalid provider links.
  }
  return null;
}

function payloadFor(job: ClaimedJob): GoogleCalendarSyncPayload {
  const start = new Date(job.startsAt);
  return {
    summary: title,
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + job.duration * 60_000).toISOString(),
    marker: `${job.eventId}:${job.desiredVersion}`,
  };
}

function owns(event: GoogleCalendarSyncEvent, job: ClaimedJob) {
  const prefix = `${job.eventId}:`;
  return (
    typeof event.marker === 'string' &&
    event.marker.startsWith(prefix) &&
    /^\d+$/.test(event.marker.slice(prefix.length))
  );
}

function matches(event: GoogleCalendarSyncEvent, payload: GoogleCalendarSyncPayload) {
  return (
    !!event.etag &&
    event.marker === payload.marker &&
    event.summary === payload.summary &&
    !!event.startsAt &&
    Date.parse(event.startsAt) === Date.parse(payload.startsAt) &&
    !!event.endsAt &&
    Date.parse(event.endsAt) === Date.parse(payload.endsAt) &&
    !event.hasUnexpectedContent
  );
}

async function complete(
  db: SQL,
  job: ClaimedJob,
  action: Action,
  version: number,
  event: GoogleCalendarSyncEvent | null,
  now: Date,
) {
  await db.query(
    `UPDATE google_calendar_sync SET
       state = CASE WHEN "desiredAction" = $6 AND "desiredVersion" = $7 THEN 'synced' ELSE 'pending' END,
       "appliedVersion" = $7, etag = $8, "eventLink" = $9, "nextAttemptAt" = $10,
       candidate = NULL, "restoreRequested" = false, reason = NULL, attempts = 0,
       "leaseToken" = NULL, "leaseUntil" = NULL
     WHERE ${ownedClaim}`,
    [
      ...claimParams(job),
      action,
      version,
      event?.etag ?? null,
      safeEventLink(event?.eventLink ?? null),
      now.toISOString(),
    ],
  );
}

async function review(db: SQL, job: ClaimedJob, reason: ReviewReason) {
  await db.query(
    `UPDATE google_calendar_sync SET state = 'needs_review', reason = $6,
       "leaseToken" = NULL, "leaseUntil" = NULL
     WHERE ${ownedClaim}`,
    [...claimParams(job), reason],
  );
}

async function retry(db: SQL, job: ClaimedJob, now: Date, retryAfterMs?: number) {
  await db.query(
    `UPDATE google_calendar_sync SET
       attempts = attempts + 1,
       "nextAttemptAt" = $6::timestamptz + LEAST(3600000, GREATEST($7::integer, 5000 * (1 << attempts))) * interval '1 millisecond',
       state = CASE WHEN attempts + 1 >= $8 THEN 'needs_review' ELSE 'pending' END,
       reason = CASE WHEN attempts + 1 >= $8 THEN 'retry_exhausted' ELSE NULL END,
       "leaseToken" = NULL, "leaseUntil" = NULL
     WHERE ${ownedClaim}`,
    [
      ...claimParams(job),
      now.toISOString(),
      Number.isFinite(retryAfterMs)
        ? Math.trunc(Math.min(3_600_000, Math.max(0, retryAfterMs!)))
        : 0,
      maxAttempts,
    ],
  );
}

async function release(db: SQL, job: ClaimedJob) {
  await db.query(
    `UPDATE google_calendar_sync SET "leaseToken" = NULL, "leaseUntil" = NULL WHERE ${ownedClaim}`,
    claimParams(job),
  );
}

async function reconnect(db: Database, job: ClaimedJob) {
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE google_calendar_connections
       SET status = 'needs_reconnect', "updatedAt" = now()
       WHERE "ownerId" = $1 AND id = $2 AND "calendarId" = $6
         AND status = 'connected' AND "updatedAt" = $7::timestamptz
         AND EXISTS (SELECT 1 FROM google_calendar_sync WHERE ${ownedClaim})`,
      [...claimParams(job), job.calendarId, job.connectionVersion],
    );
    await release(tx, job);
  });
}

async function reserveWrite(db: SQL, job: ClaimedJob, candidate: Candidate, now: Date) {
  const [reserved] = await db.query(
    `UPDATE google_calendar_sync q SET candidate = $6::jsonb, "restoreRequested" = false
     WHERE ${ownedClaim} AND "leaseUntil" > $7
       AND (q.candidate IS NOT NULL OR (q."desiredVersion" = $9 AND q."desiredAction" = $10))
       AND EXISTS (
         SELECT 1 FROM google_calendar_connections c
         WHERE c."ownerId" = q."ownerId" AND c.id = q."connectionId"
           AND c."calendarId" = $8 AND c.status = 'connected' AND c."refreshCiphertext" IS NOT NULL
       )
     RETURNING 1`,
    [
      ...claimParams(job),
      JSON.stringify(candidate),
      now.toISOString(),
      job.calendarId,
      job.desiredVersion,
      job.desiredAction,
    ],
  );
  return !!reserved;
}

async function providerCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof GoogleCalendarSyncError) throw error;
    throw new GoogleCalendarSyncError('retry');
  }
}

async function publish(
  db: SQL,
  transport: GoogleCalendarSyncTransport,
  job: ClaimedJob,
  target: GoogleCalendarSyncTarget,
  candidate: Candidate,
  clock: () => Date,
) {
  if (!(await reserveWrite(db, job, candidate, clock()))) {
    await release(db, job);
    return;
  }
  if (candidate.operation === 'delete') {
    await providerCall(() => transport.remove(target, candidate.etag));
    await complete(db, job, 'delete', candidate.version, null, clock());
    return;
  }
  const event = await providerCall(() =>
    candidate.operation === 'insert'
      ? transport.insert(target, candidate.payload)
      : transport.update(target, candidate.payload, candidate.etag),
  );
  if (!matches(event, candidate.payload)) throw new GoogleCalendarSyncError('retry');
  await complete(db, job, 'upsert', candidate.version, event, clock());
}

async function replaceMissingEvent(db: Database, job: ClaimedJob) {
  await db.transaction(async (tx) => {
    await tx.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [job.ownerId]);
    const [replacement] = await tx.query(
      `WITH retired AS (
         UPDATE google_calendar_sync
         SET state = 'synced', "desiredAction" = 'delete', etag = NULL, "eventLink" = NULL,
             candidate = NULL, "restoreRequested" = false, "leaseToken" = NULL, "leaseUntil" = NULL
         WHERE ${ownedClaim} AND "desiredVersion" = $6 AND "desiredAction" = 'upsert'
         RETURNING "ownerId", "connectionId", "lessonId", generation, "desiredVersion", "startsAt", duration
       )
       INSERT INTO google_calendar_sync
         ("ownerId", "connectionId", "lessonId", generation, "eventId",
          "desiredAction", "desiredVersion", "startsAt", duration)
       SELECT "ownerId", "connectionId", "lessonId", generation + 1,
              ${stableEventId('"connectionId"', '"lessonId"', 'generation + 1')},
              'upsert', "desiredVersion", "startsAt", duration FROM retired
       RETURNING 1`,
      [...claimParams(job), job.desiredVersion],
    );
    if (!replacement) await release(tx, job);
  });
}

async function applyJob(
  db: Database,
  transport: GoogleCalendarSyncTransport,
  job: ClaimedJob,
  clock: () => Date,
) {
  const { ownerId, connectionId, calendarId, eventId: id } = job;
  const target = { ownerId, connectionId, calendarId, eventId: id };
  const remote = await providerCall(() => transport.get(target));
  if (remote && (!owns(remote, job) || !remote.etag)) {
    await review(db, job, 'ownership_mismatch');
    return;
  }
  if (remote?.hasUnexpectedContent) {
    await review(db, job, 'remote_changed');
    return;
  }

  if (job.candidate) {
    // An uncertain write is reconciled before sending any later version.
    const candidate = job.candidate;
    if (candidate.operation === 'delete' && !remote) {
      await complete(db, job, 'delete', candidate.version, null, clock());
    } else if (candidate.operation !== 'delete' && remote && matches(remote, candidate.payload)) {
      await complete(db, job, 'upsert', candidate.version, remote, clock());
    } else if (candidate.operation === 'insert' ? !remote : remote?.etag === candidate.etag) {
      await publish(db, transport, job, target, candidate, clock);
    } else {
      await review(db, job, remote ? 'remote_changed' : 'remote_missing');
    }
    return;
  }

  const action = job.desiredAction;
  const version = job.desiredVersion;
  if (job.restoreRequested && !remote && action === 'upsert') {
    // Google reserves deleted event IDs. An explicit restore starts a new generation.
    await replaceMissingEvent(db, job);
    return;
  }
  if (!job.restoreRequested) {
    if (remote && !job.etag) {
      // An older local snapshot can reconstruct a mapping without the original acknowledgment.
      if (action === 'upsert' && matches(remote, payloadFor(job)))
        await complete(db, job, action, version, remote, clock());
      else await review(db, job, 'remote_changed');
      return;
    }
    if (remote && (remote.etag !== job.etag || remote.marker !== `${id}:${job.appliedVersion}`)) {
      await review(db, job, 'remote_changed');
      return;
    }
    if (!remote && job.etag) {
      await review(db, job, 'remote_missing');
      return;
    }
  }

  if (action === 'delete') {
    if (remote)
      await publish(
        db,
        transport,
        job,
        target,
        { operation: 'delete', version, etag: remote.etag },
        clock,
      );
    else await complete(db, job, 'delete', version, null, clock());
    return;
  }

  const payload = payloadFor(job);
  await publish(
    db,
    transport,
    job,
    target,
    remote
      ? { operation: 'update', version, payload, etag: remote.etag }
      : { operation: 'insert', version, payload },
    clock,
  );
}

export async function processGoogleCalendarSync(
  db: Database,
  transport: GoogleCalendarSyncTransport,
  options: { limit?: number; now?: Date } = {},
): Promise<number> {
  const clock = () => options.now ?? new Date();
  const limit = Math.max(0, Math.min(100, options.limit ?? 20));
  let processed = 0;
  while (processed < limit) {
    const job = await claim(db, clock());
    if (!job) break;
    processed++;
    try {
      await applyJob(db, transport, job, clock);
    } catch (error) {
      if (!(error instanceof GoogleCalendarSyncError)) throw error;
      const kind = error.kind;
      if (kind === 'reconnect') await reconnect(db, job);
      else if (kind === 'precondition') await review(db, job, 'remote_changed');
      else if (kind === 'not_found') await review(db, job, 'remote_missing');
      else if (kind === 'invalid') await review(db, job, 'provider_rejected');
      else await retry(db, job, clock(), error.retryAfterMs);
    }
  }
  return processed;
}

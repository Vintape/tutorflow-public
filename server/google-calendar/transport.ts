import type { Database } from '../db.js';
import type { GoogleCalendarBusyInterval } from '../../shared/google-calendar.js';
import {
  decryptGoogleCalendarRefreshToken,
  encryptGoogleCalendarRefreshToken,
  GoogleCalendarError,
  type GoogleCalendarClient,
  type GoogleCalendarEvent,
} from './oauth.js';
import {
  GoogleCalendarSyncError,
  type GoogleCalendarSyncEvent,
  type GoogleCalendarSyncPayload,
  type GoogleCalendarSyncTarget,
  type GoogleCalendarSyncTransport,
} from './sync.js';

const marker = 'tutorflowEvent';
export function createGoogleCalendarSyncTransport(
  db: Database,
  client: GoogleCalendarClient,
  key: Uint8Array,
): GoogleCalendarSyncTransport & {
  busy(
    target: Omit<GoogleCalendarSyncTarget, 'eventId'>,
    range: { from: string; to: string },
  ): Promise<GoogleCalendarBusyInterval[]>;
} {
  const tokens = new Map<string, { token: string; ciphertext: string; expiresAt: number }>();
  async function access(target: Omit<GoogleCalendarSyncTarget, 'eventId'>) {
    const [row] = await db.query<{ googleSubject: string; refreshCiphertext: string }>(
      `SELECT "googleSubject","refreshCiphertext" FROM google_calendar_connections
       WHERE "ownerId"=$1 AND id=$2 AND "calendarId"=$3
       AND status='connected' AND "refreshCiphertext" IS NOT NULL`,
      [target.ownerId, target.connectionId, target.calendarId],
    );
    if (!row) throw new GoogleCalendarSyncError('reconnect');
    const cached = tokens.get(target.connectionId);
    if (cached?.ciphertext === row.refreshCiphertext && cached.expiresAt > Date.now() + 60_000)
      return cached.token;
    const context = { ownerId: target.ownerId, googleSubject: row.googleSubject };
    const refreshed = await client.refreshAccessToken(
      decryptGoogleCalendarRefreshToken(row.refreshCiphertext, key, context),
    );
    const ciphertext = refreshed.refreshToken
      ? encryptGoogleCalendarRefreshToken(refreshed.refreshToken, key, context)
      : row.refreshCiphertext;
    const [current] = await db.query<{ id: string }>(
      `UPDATE google_calendar_connections SET "refreshCiphertext"=$4
       WHERE "ownerId"=$1 AND id=$2 AND status='connected' AND "refreshCiphertext"=$3 RETURNING id`,
      [target.ownerId, target.connectionId, row.refreshCiphertext, ciphertext],
    );
    if (!current) throw new GoogleCalendarSyncError('reconnect');
    if (tokens.size >= 128) tokens.clear();
    tokens.set(target.connectionId, {
      token: refreshed.accessToken,
      ciphertext,
      expiresAt: refreshed.expiresAt.getTime(),
    });
    return refreshed.accessToken;
  }
  function event(value: GoogleCalendarEvent): GoogleCalendarSyncEvent {
    if (!value.etag || value.status === 'cancelled') throw new GoogleCalendarSyncError('not_found');
    return {
      etag: value.etag,
      eventLink: value.htmlLink ?? null,
      marker: value.extendedProperties?.private?.[marker] ?? null,
      summary: value.summary ?? null,
      startsAt: value.start?.dateTime ?? null,
      endsAt: value.end?.dateTime ?? null,
      hasUnexpectedContent: value.hasUnexpectedContent || value.status !== 'confirmed',
    };
  }
  function times(payload: GoogleCalendarSyncPayload) {
    return {
      summary: payload.summary,
      start: { dateTime: payload.startsAt },
      end: { dateTime: payload.endsAt },
    };
  }
  async function call<T>(
    target: Omit<GoogleCalendarSyncTarget, 'eventId'>,
    fn: (token: string) => Promise<T>,
  ) {
    try {
      return await fn(await access(target));
    } catch (error) {
      if (!(error instanceof GoogleCalendarError)) throw error;
      if (error.code === 'conflict') throw new GoogleCalendarSyncError('conflict');
      if (error.code === 'precondition_failed') throw new GoogleCalendarSyncError('precondition');
      if (error.code === 'not_found') throw new GoogleCalendarSyncError('not_found');
      if (
        ['unauthorized', 'invalid_grant', 'invalid_token', 'insufficient_scope'].includes(
          error.code,
        )
      ) {
        tokens.delete(target.connectionId);
        throw new GoogleCalendarSyncError('reconnect');
      }
      if (
        ['rate_limited', 'unavailable', 'invalid_response', 'provider_error'].includes(error.code)
      )
        throw new GoogleCalendarSyncError('retry', error.retryAfterMs);
      throw new GoogleCalendarSyncError('invalid');
    }
  }
  return {
    busy: (target, range) => call(target, (token) => client.queryBusy(token, range)),
    async get(target) {
      try {
        return await call(target, async (token) =>
          event(await client.getEvent(token, target.calendarId, target.eventId)),
        );
      } catch (error) {
        if (error instanceof GoogleCalendarSyncError && error.kind === 'not_found') return null;
        throw error;
      }
    },
    insert: (target, payload) =>
      call(target, async (token) =>
        event(
          await client.insertEvent(token, target.calendarId, {
            id: target.eventId,
            ...times(payload),
            extendedProperties: { private: { [marker]: payload.marker } },
          }),
        ),
      ),
    update: (target, payload, etag) =>
      call(target, async (token) =>
        event(
          await client.patchEvent(token, target.calendarId, target.eventId, etag, {
            ...times(payload),
            extendedProperties: { private: { tutorflowEvent: payload.marker } },
          }),
        ),
      ),
    remove: (target, etag) =>
      call(target, (token) => client.deleteEvent(token, target.calendarId, target.eventId, etag)),
  };
}

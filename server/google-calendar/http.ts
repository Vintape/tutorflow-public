import { randomUUID } from 'node:crypto';
import type { Express, Response } from 'express';
import { z } from 'zod';
import type {
  GoogleCalendarBusy,
  GoogleCalendarSettings,
  GoogleCalendarStatus,
} from '../../shared/google-calendar.js';
import type { Config } from '../config.js';
import type { Database } from '../db.js';
import { AppError } from '../errors.js';
import {
  createGoogleCalendarClient,
  decryptGoogleCalendarRefreshToken,
  encryptGoogleCalendarRefreshToken,
  GoogleCalendarError,
  hashGoogleCalendarState,
} from './oauth.js';
import {
  countInitialGoogleCalendarLessons,
  enqueueInitialGoogleCalendarLessons,
  listGoogleCalendarSyncStates,
  processGoogleCalendarSync,
  resolveGoogleCalendarSync,
} from './sync.js';
import { createGoogleCalendarSyncTransport } from './transport.js';

const path = '/api/integrations/google-calendar';
type Client = ReturnType<typeof createGoogleCalendarClient>;
interface Connection {
  ownerId: string;
  id: string;
  googleSubject: string;
  refreshCiphertext: string | null;
  calendarId: string | null;
  status: Exclude<GoogleCalendarStatus, 'unavailable'>;
  needsReview: boolean;
  canReadBusy: boolean;
}
function owner(res: Response): string {
  return (res.locals.user as { id: string }).id;
}
function session(res: Response): string {
  return res.locals.sessionId as string;
}
function reconnect(error: unknown) {
  return (
    error instanceof GoogleCalendarError &&
    ['invalid_grant', 'unauthorized', 'invalid_token'].includes(error.code)
  );
}

export function mountGoogleCalendar(
  app: Express,
  db: Database,
  config: Config,
  injectedClient?: Client,
) {
  const credentials = config.googleCalendar;
  const key = credentials ? Buffer.from(credentials.encryptionKey, 'hex') : undefined;
  function configuredClient() {
    if (!credentials || key?.length !== 32) return undefined;
    try {
      return (
        injectedClient ??
        createGoogleCalendarClient({
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          redirectUri: new URL(`${path}/callback`, config.appUrl).href,
        })
      );
    } catch {
      console.warn('Google Calendar setup is unavailable.');
      return undefined;
    }
  }
  const client = configuredClient();
  if (!client || !key) {
    app.get(path, (_req, res) =>
      res.json({
        status: 'unavailable',
        futureLessons: 0,
        hasCalendar: false,
      } satisfies GoogleCalendarSettings),
    );
    app.get(`${path}/states`, (_req, res) => res.json([]));
    app.get(`${path}/busy`, (_req, res) =>
      res.json({ status: 'inactive', intervals: [] } satisfies GoogleCalendarBusy),
    );
    return;
  }

  async function connection(ownerId: string) {
    return (
      await db.query<Connection>('SELECT * FROM google_calendar_connections WHERE "ownerId"=$1', [
        ownerId,
      ])
    )[0];
  }
  async function settings(ownerId: string): Promise<GoogleCalendarSettings> {
    const item = await connection(ownerId);
    const futureLessons =
      item?.status === 'ready' ? await countInitialGoogleCalendarLessons(db, ownerId) : 0;
    return {
      status: item?.status ?? 'disconnected',
      futureLessons,
      hasCalendar: !!item?.calendarId,
      ...(item?.canReadBusy ? { canReadBusy: true } : {}),
    };
  }
  app.get(path, async (_req, res) => res.json(await settings(owner(res))));
  app.post(`${path}/connect`, async (req, res) => {
    const { includeBusy } = z
      .object({ includeBusy: z.boolean().optional() })
      .strict()
      .parse(req.body);
    if (includeBusy && (await connection(owner(res)))?.status !== 'connected')
      throw new AppError(409, 'Сначала подключите отправку занятий', 'CALENDAR_STATE');
    const authorization = client.beginAuthorization({ includeBusy });
    await db.query(
      `INSERT INTO google_calendar_oauth_states
         ("ownerId","sessionId","stateHash","codeVerifier",nonce,"expiresAt","includeBusy") VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT ("ownerId") DO UPDATE SET "sessionId"=excluded."sessionId",
         "stateHash"=excluded."stateHash","codeVerifier"=excluded."codeVerifier",
         nonce=excluded.nonce,"expiresAt"=excluded."expiresAt","includeBusy"=excluded."includeBusy","consumedAt"=NULL`,
      [
        owner(res),
        session(res),
        authorization.stateHash,
        authorization.codeVerifier,
        authorization.nonce,
        authorization.expiresAt.toISOString(),
        includeBusy ?? false,
      ],
    );
    res.json({ authorizationUrl: authorization.authorizationUrl });
  });
  app.get(`${path}/callback`, async (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    const finish = (result: string) => res.redirect(303, `/settings?googleCalendar=${result}`);
    const stateHash =
      typeof req.query.state === 'string' ? hashGoogleCalendarState(req.query.state) : null;
    if (!stateHash) return finish('invalid-state');
    const [attempt] = await db.query<{ codeVerifier: string; nonce: string; includeBusy: boolean }>(
      `UPDATE google_calendar_oauth_states SET "consumedAt"=now()
       WHERE "ownerId"=$1 AND "sessionId"=$2 AND "stateHash"=$3 AND "expiresAt">now()
       AND "consumedAt" IS NULL RETURNING "codeVerifier",nonce,"includeBusy"`,
      [owner(res), session(res), stateHash],
    );
    if (!attempt) return finish('invalid-state');
    if (req.query.error) return finish('denied');
    if (typeof req.query.code !== 'string' || req.query.code.length > 4096) return finish('failed');
    try {
      const authorization = await client.exchangeAuthorizationCode({
        code: req.query.code,
        codeVerifier: attempt.codeVerifier,
        nonce: attempt.nonce,
        requireBusy: attempt.includeBusy,
      });
      const ownerId = owner(res);
      const encrypted = encryptGoogleCalendarRefreshToken(authorization.refreshToken, key, {
        ownerId,
        googleSubject: authorization.googleSubject,
      });
      const [stored] = await db.transaction(async (tx) => {
        const [matching] = await tx.query<{ ownerId: string }>(
          `DELETE FROM google_calendar_oauth_states
           WHERE "ownerId"=$1 AND "sessionId"=$2 AND "stateHash"=$3 AND "consumedAt" IS NOT NULL
           AND "expiresAt">now() RETURNING "ownerId"`,
          [ownerId, session(res), stateHash],
        );
        if (!matching) throw new AppError(409, 'Подключение изменилось', 'CALENDAR_STATE');
        return tx.query<{ id: string }>(
          `INSERT INTO google_calendar_connections
           ("ownerId",id,"googleSubject","refreshCiphertext",status,"canReadBusy")
         VALUES ($1,$2,$3,$4,'pending_calendar',$5)
         ON CONFLICT ("ownerId") DO UPDATE SET
           "refreshCiphertext"=excluded."refreshCiphertext",
           "canReadBusy"=excluded."canReadBusy",
           status=CASE
             WHEN google_calendar_connections."needsReview" THEN 'calendar_uncertain'
             WHEN google_calendar_connections."calendarId" IS NULL THEN 'pending_calendar'
             WHEN google_calendar_connections.status='connected' THEN 'connected'
             ELSE 'ready'
           END,
           "updatedAt"=now()
         WHERE google_calendar_connections."googleSubject"=excluded."googleSubject"
         RETURNING id`,
          [
            ownerId,
            randomUUID(),
            authorization.googleSubject,
            encrypted,
            attempt.includeBusy && authorization.canReadBusy === true,
          ],
        );
      });
      return finish(stored ? 'authorized' : 'different-account');
    } catch (error) {
      return finish(
        error instanceof GoogleCalendarError && error.code === 'insufficient_scope'
          ? 'denied'
          : 'failed',
      );
    }
  });

  app.post(`${path}/calendar`, async (req, res) => {
    const input = z
      .object({
        existingCalendarId: z.string().trim().min(1).max(1024).optional(),
        retryAfterReview: z.literal(true).optional(),
      })
      .strict()
      .refine((value) => !value.existingCalendarId || !value.retryAfterReview)
      .parse(req.body);
    const ownerId = owner(res);
    const requiredStatus =
      input.existingCalendarId || input.retryAfterReview
        ? 'calendar_uncertain'
        : 'pending_calendar';
    const item = await connection(ownerId);
    if (!item?.refreshCiphertext || item.status !== requiredStatus)
      throw new AppError(409, 'Перепроверьте состояние подключения Google', 'CALENDAR_STATE');
    const claimId = randomUUID();
    const [claim] = await db.query<{ id: string }>(
      `UPDATE google_calendar_connections SET status='calendar_uncertain',"needsReview"=true,"calendarClaim"=$4,"updatedAt"=now()
       WHERE "ownerId"=$1 AND status=$2 AND "refreshCiphertext"=$3
       AND ("calendarClaim" IS NULL OR "updatedAt"<now()-interval '1 minute')
       RETURNING id`,
      [ownerId, item.status, item.refreshCiphertext, claimId],
    );
    if (!claim) throw new AppError(409, 'Подключение уже изменилось', 'CALENDAR_STATE');

    let creating = false;
    let ciphertext = item.refreshCiphertext;
    try {
      const token = decryptGoogleCalendarRefreshToken(ciphertext, key, item);
      const refreshed = await client.refreshAccessToken(token);
      if (refreshed.refreshToken) {
        ciphertext = encryptGoogleCalendarRefreshToken(refreshed.refreshToken, key, item);
        const [kept] = await db.query<{ id: string }>(
          `UPDATE google_calendar_connections SET "refreshCiphertext"=$3
           WHERE "ownerId"=$1 AND "refreshCiphertext"=$2 AND "calendarClaim"=$4 AND status='calendar_uncertain' RETURNING id`,
          [ownerId, item.refreshCiphertext, ciphertext, claimId],
        );
        if (!kept) throw new AppError(409, 'Подключение уже изменилось', 'CALENDAR_STATE');
      }
      const [prefs] = await db.query<{ timezone: string }>(
        'SELECT timezone FROM settings WHERE "ownerId"=$1',
        [ownerId],
      );
      creating = !input.existingCalendarId;
      const calendar = input.existingCalendarId
        ? await client.getCalendar(refreshed.accessToken, input.existingCalendarId)
        : await client.createCalendar(refreshed.accessToken, prefs?.timezone ?? 'UTC');
      const [stored] = await db.query<{ id: string }>(
        `UPDATE google_calendar_connections SET "calendarId"=$2,status='ready',"needsReview"=false,"calendarClaim"=NULL,"updatedAt"=now()
         WHERE "ownerId"=$1 AND "refreshCiphertext"=$3 AND "calendarClaim"=$4 AND status='calendar_uncertain' RETURNING id`,
        [ownerId, calendar.id, ciphertext, claimId],
      );
      if (!stored)
        throw new AppError(
          409,
          'Подключение изменилось. Проверьте календарь в Google.',
          'CALENDAR_STATE',
        );
      res.json(await settings(ownerId));
    } catch (error) {
      const mustReconnect = reconnect(error);
      const unknown =
        item.needsReview ||
        (creating &&
          !(
            error instanceof GoogleCalendarError &&
            ['unauthorized', 'forbidden', 'rate_limited'].includes(error.code)
          ));
      await db.query(
        `UPDATE google_calendar_connections SET status=$2,"needsReview"=$3,"calendarClaim"=NULL,"updatedAt"=now()
         WHERE "ownerId"=$1 AND "refreshCiphertext"=$4 AND "calendarClaim"=$5 AND status='calendar_uncertain'`,
        [
          ownerId,
          mustReconnect ? 'needs_reconnect' : unknown ? 'calendar_uncertain' : 'pending_calendar',
          unknown,
          ciphertext,
          claimId,
        ],
      );
      throw new AppError(
        409,
        mustReconnect
          ? 'Нужно снова подключить Google'
          : unknown
            ? 'Проверьте созданный календарь в Google'
            : 'Google не подтвердил создание календаря',
        'GOOGLE_CALENDAR',
      );
    }
  });
  app.post(`${path}/disconnect`, async (_req, res) => {
    const ownerId = owner(res);
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM google_calendar_oauth_states WHERE "ownerId"=$1', [ownerId]);
      await tx.query(
        `UPDATE google_calendar_connections SET status='disconnected',"refreshCiphertext"=NULL,"canReadBusy"=false,"calendarClaim"=NULL,"updatedAt"=now()
         WHERE "ownerId"=$1`,
        [ownerId],
      );
    });
    res.json(await settings(ownerId));
  });
  app.post(`${path}/sync`, async (_req, res) => {
    const ownerId = owner(res);
    await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [ownerId]);
      const [claimed] = await tx.query<{ id: string }>(
        `UPDATE google_calendar_connections SET status='connected',"updatedAt"=now()
         WHERE "ownerId"=$1 AND status='ready' AND "calendarId" IS NOT NULL
         AND "refreshCiphertext" IS NOT NULL RETURNING id`,
        [ownerId],
      );
      if (!claimed) throw new AppError(409, 'Сначала подключите календарь', 'CALENDAR_STATE');
      await enqueueInitialGoogleCalendarLessons(tx, ownerId);
    });
    res.json(await settings(ownerId));
  });
  app.get(`${path}/states`, async (_req, res) => {
    const lessonId = z.uuid().optional().parse(_req.query.lessonId);
    res.json(await listGoogleCalendarSyncStates(db, owner(res), lessonId));
  });
  app.post(`${path}/states/:lessonId`, async (req, res) => {
    const lessonId = z.uuid().parse(req.params.lessonId);
    const { resolution } = z
      .object({ resolution: z.enum(['keep', 'restore']) })
      .strict()
      .parse(req.body);
    if (!(await resolveGoogleCalendarSync(db, owner(res), lessonId, resolution)))
      throw new AppError(409, 'Обновите состояние занятия', 'CALENDAR_STATE');
    res.json(await listGoogleCalendarSyncStates(db, owner(res)));
  });
  const transport = createGoogleCalendarSyncTransport(db, client, key);
  app.post(`${path}/busy/disable`, async (_req, res) => {
    const ownerId = owner(res);
    await db.transaction(async (tx) => {
      await tx.query(
        'DELETE FROM google_calendar_oauth_states WHERE "ownerId"=$1 AND "includeBusy"',
        [ownerId],
      );
      await tx.query(
        'UPDATE google_calendar_connections SET "canReadBusy"=false WHERE "ownerId"=$1',
        [ownerId],
      );
    });
    res.json(await settings(ownerId));
  });
  app.get(`${path}/busy`, async (req, res) => {
    const ownerId = owner(res);
    const item = await connection(ownerId);
    if (item?.status !== 'connected' || !item.calendarId || !item.canReadBusy) {
      res.json({ status: 'inactive', intervals: [] } satisfies GoogleCalendarBusy);
      return;
    }
    const range = z
      .object({
        from: z.iso.datetime({ offset: true }),
        to: z.iso.datetime({ offset: true }),
      })
      .strict()
      .parse(req.query);
    const duration = Date.parse(range.to) - Date.parse(range.from);
    if (duration <= 0 || duration > 9 * 86400000)
      throw new AppError(422, 'Выберите диапазон занятости до девяти дней', 'CALENDAR_RANGE');
    try {
      const intervals = await transport.busy(
        { ownerId, connectionId: item.id, calendarId: item.calendarId },
        range,
      );
      res.json({ status: 'ready', intervals } satisfies GoogleCalendarBusy);
    } catch {
      res.json({ status: 'unavailable', intervals: [] } satisfies GoogleCalendarBusy);
    }
  });
  return () => processGoogleCalendarSync(db, transport, { limit: 1 });
}

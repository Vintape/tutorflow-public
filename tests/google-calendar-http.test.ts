import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createApp } from '../server/app.js';
import { createDatabase, migrate, type Database } from '../server/db.js';
import type { Config } from '../server/config.js';
import {
  createGoogleCalendarClient,
  GoogleCalendarError,
  type GoogleCalendarEvent,
  type GoogleCalendarGrant,
} from '../server/google-calendar/oauth.js';

const route = '/api/integrations/google-calendar';
const config: Config = {
  production: false,
  port: 3300,
  appUrl: 'http://localhost:3300',
  secret: 'synthetic-google-calendar-app-secret-test-only',
  databaseSSL: false,
  dataDir: 'memory://',
  aiModel: 'unused',
  aiDailyLimit: 1,
  googleCalendar: {
    clientId: 'synthetic-google-client.apps.googleusercontent.com',
    clientSecret: 'synthetic-calendar-client-secret',
    encryptionKey: 'ac'.repeat(32),
  },
};
const providerGrant = (googleSubject = 'test-google-subject'): GoogleCalendarGrant => ({
  googleSubject,
  accessToken: 'synthetic-access-token',
  refreshToken: 'synthetic-refresh-token',
  expiresAt: new Date(Date.now() + 3600_000),
});
const exchange = vi.fn(async () => providerGrant());
const create = vi.fn(async () => ({ id: 'synthetic-calendar@group.calendar.google.com' }));
let db: Database;
let server: Server;
let http: string;
let cookie: string;
let differentSession: string;
let processCalendar: () => Promise<number>;
const events = new Map<string, GoogleCalendarEvent>();
const readBusy = vi.fn(async () => [
  { start: '2026-11-25T10:00:00.000Z', end: '2026-11-25T11:00:00.000Z' },
]);

async function request(path: string, method = 'GET', auth = cookie, data: unknown = {}) {
  return fetch(http + path, {
    redirect: 'manual',
    method,
    headers: { Origin: config.appUrl, Cookie: auth, 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(data),
  });
}
async function begin(includeBusy = false) {
  const response = await request(route + '/connect', 'POST', cookie, { includeBusy });
  expect(response.status).toBe(200);
  const { authorizationUrl } = (await response.json()) as { authorizationUrl: string };
  const state = new URL(authorizationUrl).searchParams.get('state')!;
  return route + '/callback?' + new URLSearchParams({ code: 'synthetic-code', state });
}
beforeAll(async () => {
  db = await createDatabase(config);
  await migrate(db);
  const client = createGoogleCalendarClient({
    ...config.googleCalendar!,
    redirectUri: config.appUrl + route + '/callback',
    fetch: async () => {
      throw new Error('Live provider forbidden in test');
    },
  });
  const { app, processGoogleCalendar } = createApp(db, config, undefined, undefined, {
    ...client,
    exchangeAuthorizationCode: exchange,
    createCalendar: create,
    refreshAccessToken: async () => providerGrant(),
    getEvent: async (_token, _calendar, id) => {
      const event = events.get(id);
      if (!event) throw new GoogleCalendarError('not_found');
      return event;
    },
    insertEvent: async (_token, _calendar, input) => {
      const event: GoogleCalendarEvent = {
        ...input,
        status: 'confirmed',
        etag: '"1"',
        hasUnexpectedContent: false,
      };
      events.set(event.id, event);
      return event;
    },
    patchEvent: async (_token, _calendar, id, etag, patch) => {
      const event = events.get(id)!;
      expect(event.etag).toBe(etag);
      const updated = { ...event, ...patch, etag: '"2"' };
      events.set(id, updated);
      return updated;
    },
    deleteEvent: async (_token, _calendar, id, etag) => {
      expect(events.get(id)?.etag).toBe(etag);
      events.delete(id);
    },
    queryBusy: readBusy,
  });
  processCalendar = processGoogleCalendar!;
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected listener');
  http = `http://127.0.0.1:${address.port}`;
  const credentials = {
    email: 'calendar-http@tutorflow.test',
    password: 'SyntheticCalendarHttp123!',
  };
  const signup = await request('/api/auth/sign-up/email', 'POST', '', {
    name: 'Synthetic Calendar User',
    ...credentials,
  });
  expect(signup.status).toBe(200);
  cookie = signup.headers
    .getSetCookie()
    .map((part) => part.split(';')[0])
    .join('; ');
  const signin = await request('/api/auth/sign-in/email', 'POST', '', credentials);
  expect(signin.status).toBe(200);
  differentSession = signin.headers
    .getSetCookie()
    .map((part) => part.split(';')[0])
    .join('; ');
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.close();
});

it('binds OAuth callback to one login session, consumes it once, and never returns tokens', async () => {
  expect((await request(route, 'GET', '')).status).toBe(401);
  const callback = await begin();
  expect((await request(callback, 'GET', differentSession)).headers.get('location')).toContain(
    'invalid-state',
  );
  const accepted = await request(callback);
  expect(accepted.headers.get('location')).toBe('/settings?googleCalendar=authorized');
  expect(accepted.headers.get('referrer-policy')).toBe('no-referrer');
  expect((await request(callback)).headers.get('location')).toContain('invalid-state');
  expect(exchange).toHaveBeenCalledTimes(1);
  const state = await request(route);
  expect(await state.json()).toEqual({
    status: 'pending_calendar',
    futureLessons: 0,
    hasCalendar: false,
  });
  const [connection] = await db.query<{ refreshCiphertext: string }>(
    'SELECT "refreshCiphertext" FROM google_calendar_connections',
  );
  expect(connection.refreshCiphertext).not.toContain('synthetic-refresh-token');
});

it('keeps calendar creation and activation separate, and stops sync on disconnect', async () => {
  create.mockRejectedValueOnce(new GoogleCalendarError('unavailable'));
  expect((await request(route + '/calendar', 'POST')).status).toBe(409);
  expect(await (await request(route)).json()).toMatchObject({ status: 'calendar_uncertain' });
  expect((await request(route + '/calendar', 'POST')).status).toBe(409);
  expect(create).toHaveBeenCalledTimes(1);
  const calendar = await request(route + '/calendar', 'POST', cookie, { retryAfterReview: true });
  expect(calendar.status).toBe(200);
  expect(await calendar.json()).toMatchObject({ status: 'ready', hasCalendar: true });
  expect((await request(route + '/calendar', 'POST')).status).toBe(409);
  expect(create).toHaveBeenCalledTimes(2);
  const student = await request('/api/students', 'POST', cookie, {
    name: 'Synthetic private learner',
    subject: 'Math',
    level: '',
    price: 125001,
    duration: 60,
    goal: '',
    notes: 'Private fixture',
  });
  expect(student.status).toBe(201);
  const startsAt = new Date(Date.now() + 10 * 86400000).toISOString();
  const created = await request('/api/lessons', 'POST', cookie, {
    studentId: (await student.json()).id,
    startsAt,
    topic: 'Private test topic',
    allowConflict: false,
  });
  expect(created.status).toBe(201);
  const lesson = (await created.json()) as { id: string; version: number };
  expect(await (await request(route)).json()).toMatchObject({ status: 'ready', futureLessons: 1 });
  expect(await processCalendar()).toBe(0);
  const active = await request(route + '/sync', 'POST');
  expect(active.status).toBe(200);
  expect(await active.json()).toMatchObject({ status: 'connected' });
  expect(await processCalendar()).toBe(1);
  const [event] = events.values();
  expect(event).toMatchObject({ summary: 'Занятие TutorFlow', start: { dateTime: startsAt } });
  expect(JSON.stringify(event)).not.toMatch(
    /Synthetic private learner|Private test topic|Private fixture/,
  );
  expect(await (await request(`${route}/states?lessonId=${lesson.id}`)).json()).toMatchObject([
    { status: 'synced' },
  ]);
  const movedTime = new Date(Date.parse(startsAt) + 7200000).toISOString();
  const moved = await request(`/api/lessons/${lesson.id}`, 'PATCH', cookie, {
    version: lesson.version,
    startsAt: movedTime,
  });
  expect(moved.status).toBe(200);
  expect(await processCalendar()).toBe(1);
  expect(events.size).toBe(1);
  expect(events.get(event.id)?.start?.dateTime).toBe(movedTime);
  const cancelled = await request(`/api/lessons/${lesson.id}`, 'PATCH', cookie, {
    version: (await moved.json()).version,
    status: 'CANCELLED',
  });
  expect(cancelled.status).toBe(200);
  expect(await processCalendar()).toBe(1);
  expect(events.size).toBe(0);
  const range = new URLSearchParams({ from: '2026-11-25T00:00:00Z', to: '2026-11-26T00:00:00Z' });
  const path = `${route}/busy?${range}`;
  expect(await (await request(path)).json()).toMatchObject({ status: 'inactive', intervals: [] });
  expect(readBusy).not.toHaveBeenCalled();
  exchange.mockResolvedValueOnce({ ...providerGrant(), canReadBusy: true });
  expect((await request(await begin(true))).headers.get('location')).toContain('authorized');
  expect(await (await request(path)).json()).toMatchObject({
    status: 'ready',
    intervals: await readBusy.mock.results[0].value,
  });
  expect((await request(route + '/busy/disable', 'POST')).status).toBe(200);
  expect(await (await request(path)).json()).toMatchObject({ status: 'inactive', intervals: [] });
  const disconnected = await request(route + '/disconnect', 'POST');
  expect(await disconnected.json()).toMatchObject({ status: 'disconnected', hasCalendar: true });
  const [row] = await db.query<{ refreshCiphertext: string | null }>(
    'SELECT "refreshCiphertext" FROM google_calendar_connections',
  );
  expect(row.refreshCiphertext).toBeNull();
});

it('does not connect a different Google account or finish an exchange after disconnect', async () => {
  exchange.mockResolvedValueOnce(providerGrant('another-subject'));
  expect((await request(await begin())).headers.get('location')).toContain('different-account');
  let entered!: () => void;
  const accepted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: (result: GoogleCalendarGrant) => void;
  exchange.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
        entered();
      }),
  );
  const exchanging = request(await begin());
  await accepted;
  expect((await request(route + '/disconnect', 'POST')).status).toBe(200);
  finish(providerGrant());
  expect((await exchanging).headers.get('location')).toContain('failed');
  expect(await (await request(route)).json()).toMatchObject({ status: 'disconnected' });
});

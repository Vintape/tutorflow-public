import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createGoogleCalendarClient,
  decryptGoogleCalendarRefreshToken,
  encryptGoogleCalendarRefreshToken,
  hashGoogleCalendarState,
} from '../server/google-calendar/oauth.js';

const clientId = 'synthetic.apps.googleusercontent.com';
const clientSecret = 'synthetic-client-secret';
const redirectUri = 'https://tutorflow.test/api/google-calendar/callback';
const calendarScope = 'https://www.googleapis.com/auth/calendar.app.created';
const busyScope = 'https://www.googleapis.com/auth/calendar.freebusy';
const timestamp = Date.parse('2026-11-19T12:00:00Z');
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };

function setup(timeoutMs?: number) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const client = createGoogleCalendarClient({
    clientId,
    clientSecret,
    redirectUri,
    fetch,
    now: () => timestamp,
    timeoutMs,
  });
  return { fetch, client };
}

function idToken(nonce: string, claims: Record<string, unknown> = {}) {
  const token = [
    { alg: 'RS256', kid: jwk.kid },
    {
      iss: 'https://accounts.google.com',
      aud: clientId,
      sub: 'immutable-google-subject',
      iat: timestamp / 1000 - 10,
      exp: timestamp / 1000 + 3600,
      nonce,
      ...claims,
    },
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.');
  return token + '.' + sign('RSA-SHA256', Buffer.from(token), privateKey).toString('base64url');
}

function tokens(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'synthetic-access-token',
    refresh_token: 'synthetic-refresh-token',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: `${calendarScope} openid`,
    ...overrides,
  };
}

describe('Google Calendar OAuth', () => {
  it('requests offline authorization with only Calendar and OpenID scopes, PKCE and one-time parameters', () => {
    const { client, fetch } = setup();
    const first = client.beginAuthorization();
    const url = new URL(first.authorizationUrl);
    const state = url.searchParams.get('state')!;
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: `openid ${calendarScope}`,
      access_type: 'offline',
      prompt: 'consent select_account',
      nonce: first.nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(first.codeVerifier).digest('base64url'),
    });
    expect(url.searchParams.has('client_secret')).toBe(false);
    expect(url.searchParams.has('code_verifier')).toBe(false);
    expect(first.stateHash).toBe(hashGoogleCalendarState(state));
    expect(first.stateHash).not.toBe(state);
    expect(hashGoogleCalendarState('bad state')).toBeNull();
    expect(first.expiresAt.getTime()).toBe(timestamp + 10 * 60 * 1000);
    const second = client.beginAuthorization();
    expect(second.stateHash).not.toBe(first.stateHash);
    expect(second.codeVerifier).not.toBe(first.codeVerifier);
    expect(second.nonce).not.toBe(first.nonce);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('exchanges the code with the configured callback and binds the verified Google subject', async () => {
    const { client, fetch } = setup();
    const { nonce, codeVerifier } = client.beginAuthorization();
    fetch
      .mockResolvedValueOnce(Response.json(tokens({ id_token: idToken(nonce) })))
      .mockResolvedValueOnce(Response.json({ keys: [jwk] }));

    await expect(
      client.exchangeAuthorizationCode({ code: 'example/code', codeVerifier, nonce }),
    ).resolves.toEqual({
      accessToken: 'synthetic-access-token',
      refreshToken: 'synthetic-refresh-token',
      expiresAt: new Date(timestamp + 3600 * 1000),
      googleSubject: 'immutable-google-subject',
      canReadBusy: false,
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(Object.fromEntries(init!.body as URLSearchParams)).toEqual({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code: 'example/code',
      code_verifier: codeVerifier,
    });
    expect(fetch.mock.calls[1][0]).toBe('https://www.googleapis.com/oauth2/v3/certs');
  });

  it.each([
    ['issuer', { iss: 'https://untrusted.test' }],
    ['audience', { aud: 'someone-else' }],
    ['authorized party', { azp: 'someone-else' }],
    ['nonce', { nonce: 'replayed-nonce' }],
    ['subject', { sub: '' }],
    ['expiry', { exp: timestamp / 1000 }],
    ['issue time', { iat: timestamp / 1000 + 61 }],
    ['access token hash', { at_hash: 'wrong-hash' }],
  ])(
    'rejects an ID token with the wrong %s despite its trusted signature',
    async (_name, claims) => {
      const { client, fetch } = setup();
      const { nonce, codeVerifier } = client.beginAuthorization();
      fetch
        .mockResolvedValueOnce(Response.json(tokens({ id_token: idToken(nonce, claims) })))
        .mockResolvedValueOnce(Response.json({ keys: [jwk] }));
      await expect(
        client.exchangeAuthorizationCode({ code: 'example/code', codeVerifier, nonce }),
      ).rejects.toMatchObject({ code: 'invalid_identity' });
    },
  );

  it('rejects a forged ID token even when its claims and key ID look valid', async () => {
    const { client, fetch } = setup();
    const { nonce, codeVerifier } = client.beginAuthorization();
    const [header, claims, signature] = idToken(nonce).split('.');
    const modified = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    fetch
      .mockResolvedValueOnce(Response.json(tokens({ id_token: `${header}.${claims}.${modified}` })))
      .mockResolvedValueOnce(Response.json({ keys: [jwk] }));
    await expect(
      client.exchangeAuthorizationCode({ code: 'example/code', codeVerifier, nonce }),
    ).rejects.toMatchObject({ code: 'invalid_identity' });
  });

  it.each([
    ['insufficient_scope', { scope: 'openid' }],
    ['insufficient_scope', { scope: calendarScope }],
    ['insufficient_scope', { scope: `openid ${calendarScope} email` }],
    ['missing_refresh_token', { refresh_token: undefined }],
  ])('fails with %s when the initial grant cannot be saved', async (code, overrides) => {
    const { client, fetch } = setup();
    const { nonce, codeVerifier } = client.beginAuthorization();
    fetch.mockResolvedValueOnce(Response.json(tokens({ id_token: idToken(nonce), ...overrides })));
    await expect(
      client.exchangeAuthorizationCode({ code: 'example/code', codeVerifier, nonce }),
    ).rejects.toMatchObject({ code });
  });

  it('adds only the narrow busy permission when explicitly requested and reports verified consent', async () => {
    const { client, fetch } = setup();
    const { authorizationUrl, nonce, codeVerifier } = client.beginAuthorization({
      includeBusy: true,
    });
    const scope = new URL(authorizationUrl).searchParams.get('scope');
    expect(scope).toBe(`openid ${calendarScope} ${busyScope}`);
    fetch
      .mockResolvedValueOnce(Response.json(tokens({ scope, id_token: idToken(nonce) })))
      .mockResolvedValueOnce(Response.json({ keys: [jwk] }))
      .mockResolvedValueOnce(Response.json(tokens({ scope, refresh_token: undefined })));
    await expect(
      client.exchangeAuthorizationCode({
        code: 'example/code',
        codeVerifier,
        nonce,
        requireBusy: true,
      }),
    ).resolves.toMatchObject({ googleSubject: 'immutable-google-subject', canReadBusy: true });
    await expect(client.refreshAccessToken('current-token')).resolves.toMatchObject({
      accessToken: 'synthetic-access-token',
    });
  });

  it('rejects partial consent when busy access was requested and not granted', async () => {
    const { client, fetch } = setup();
    const { nonce, codeVerifier } = client.beginAuthorization({ includeBusy: true });
    fetch.mockResolvedValueOnce(Response.json(tokens({ id_token: idToken(nonce) })));
    await expect(
      client.exchangeAuthorizationCode({
        code: 'example/code',
        codeVerifier,
        nonce,
        requireBusy: true,
      }),
    ).rejects.toMatchObject({ code: 'insufficient_scope' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reconnects Calendar without granting local busy access if Google includes a prior scope', async () => {
    const { client, fetch } = setup();
    const { nonce, codeVerifier } = client.beginAuthorization();
    fetch
      .mockResolvedValueOnce(
        Response.json(
          tokens({ scope: `openid ${calendarScope} ${busyScope}`, id_token: idToken(nonce) }),
        ),
      )
      .mockResolvedValueOnce(Response.json({ keys: [jwk] }));
    await expect(
      client.exchangeAuthorizationCode({ code: 'example/code', codeVerifier, nonce }),
    ).resolves.toMatchObject({ canReadBusy: false });
  });

  it('refreshes the access token and preserves the stored token when rotation is absent', async () => {
    const { client, fetch } = setup();
    fetch
      .mockResolvedValueOnce(Response.json(tokens({ scope: undefined, refresh_token: undefined })))
      .mockResolvedValueOnce(Response.json(tokens({ refresh_token: 'rotated-token' })));
    const expected = {
      accessToken: 'synthetic-access-token',
      expiresAt: new Date(timestamp + 3600 * 1000),
    };
    await expect(client.refreshAccessToken('current-token')).resolves.toEqual(expected);
    await expect(client.refreshAccessToken('current-token')).resolves.toEqual({
      ...expected,
      refreshToken: 'rotated-token',
    });
    expect(Object.fromEntries(fetch.mock.calls[0][1]!.body as URLSearchParams)).toEqual({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: 'current-token',
    });
  });

  it('classifies a revoked token without storing Google error details in the exception', async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(
      Response.json(
        { error: 'invalid_grant', error_description: 'credential-like response' },
        { status: 400 },
      ),
    );
    const error = await client.refreshAccessToken('current-token').catch((error: Error) => error);
    expect(error).toMatchObject({
      code: 'invalid_grant',
      message: 'Google Calendar: invalid_grant',
    });
    expect((error as Error).cause).toBeUndefined();
  });

  it.each([
    [429, '42', 'rate_limited', 42_000],
    [503, new Date(timestamp + 125_000).toUTCString(), 'unavailable', 125_000],
    [429, '99999999999', 'rate_limited', 3_600_000],
    [503, new Date(timestamp - 125_000).toUTCString(), 'unavailable', 0],
    [429, 'secret-like invalid header', 'rate_limited', undefined],
  ])('uses a bounded Retry-After hint for HTTP %d', async (status, value, code, retryAfterMs) => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(new Response(null, { status, headers: { 'Retry-After': value } }));
    const error = await client.refreshAccessToken('current-token').catch((error: Error) => error);
    expect(error).toMatchObject({ code, message: 'Google Calendar: ' + code });
    expect((error as { retryAfterMs?: number }).retryAfterMs).toBe(retryAfterMs);
  });

  it('ends a stalled request with an abort signal and a fixed error', async () => {
    const { client, fetch } = setup(10);
    fetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () =>
            reject(new Error('request includes credentials')),
          );
        }),
    );
    const error = await client.refreshAccessToken('current-token').catch((error: Error) => error);
    expect(error).toMatchObject({
      code: 'unavailable',
      message: 'Google Calendar: unavailable',
    });
    expect((error as Error).cause).toBeUndefined();
  });

  it('uses bearer authentication and sends only the calendar title and time zone when creating it', async () => {
    const { client, fetch } = setup();
    const id = 'calendar@example.test';
    fetch
      .mockResolvedValueOnce(Response.json({ id, extra: 'ignored' }))
      .mockResolvedValueOnce(Response.json({ id, extra: 'ignored' }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(client.createCalendar('current-access-token', 'Europe/Moscow')).resolves.toEqual({
      id,
    });
    await expect(client.getCalendar('current-access-token', id)).resolves.toEqual({ id });
    await expect(client.revokeRefreshToken('current-refresh-token')).resolves.toBeUndefined();
    expect(fetch.mock.calls[0][0]).toBe('https://www.googleapis.com/calendar/v3/calendars');
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ summary: 'TutorFlow', timeZone: 'Europe/Moscow' }),
      headers: { Authorization: 'Bearer current-access-token' },
    });
    expect(fetch.mock.calls[1][0]).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/calendar%40example.test',
    );
    expect(fetch.mock.calls[2][0]).toBe('https://oauth2.googleapis.com/revoke');
    expect(fetch.mock.calls[2][1]!.body).toEqual(
      new URLSearchParams({ token: 'current-refresh-token' }),
    );
  });
});

describe('Google Calendar FreeBusy', () => {
  const from = '2026-10-25T01:00:00+02:00';
  const to = '2026-10-25T04:00:00+01:00';
  const timeMin = '2026-10-24T23:00:00.000Z';
  const timeMax = '2026-10-25T03:00:00.000Z';
  const clockChange = {
    start: '2026-10-25T02:20:00+02:00',
    end: '2026-10-25T02:10:00+01:00',
  };
  const busy = [clockChange];

  it('requests only the authorized primary calendar and returns only UTC intervals across DST', async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(
      Response.json({
        timeMin,
        timeMax,
        calendars: {
          primary: { busy: [{ ...clockChange, details: 'private event data' }] },
        },
      }),
    );
    await expect(client.queryBusy('current-access-token', { from, to })).resolves.toEqual([
      { start: '2026-10-25T00:20:00.000Z', end: '2026-10-25T01:10:00.000Z' },
    ]);
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/freeBusy');
    expect(request).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer current-access-token' },
    });
    expect(JSON.parse(request!.body as string)).toEqual({
      timeMin,
      timeMax,
      items: [{ id: 'primary' }],
    });
  });

  it('distinguishes a known empty primary calendar from an incomplete response', async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(
      Response.json({ timeMin, timeMax, calendars: { primary: { busy: [] } } }),
    );
    await expect(client.queryBusy('current-access-token', { from, to })).resolves.toEqual([]);
  });

  it('accepts the one resolved calendar ID without returning that ID', async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(
      Response.json({ timeMin, timeMax, calendars: { 'private-calendar@example.test': { busy } } }),
    );
    await expect(client.queryBusy('current-access-token', { from, to })).resolves.toEqual([
      { start: '2026-10-25T00:20:00.000Z', end: '2026-10-25T01:10:00.000Z' },
    ]);
  });

  it.each([
    ['missing primary', {}],
    ['multiple calendars', { primary: { busy }, secondary: { busy: [] } }],
    ['missing intervals', { primary: {} }],
    [
      'partial provider errors',
      { primary: { busy, errors: [{ reason: 'internalError', message: 'private event data' }] } },
    ],
    ['invalid start', { primary: { busy: [{ ...clockChange, start: '2026-02-30T00:00:00Z' }] } }],
    ['reversed times', { primary: { busy: [{ start: clockChange.end, end: clockChange.start }] } }],
  ])('reports %s as unknown instead of free', async (_name, calendars) => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(Response.json({ timeMin, timeMax, calendars }));
    await expect(client.queryBusy('current-access-token', { from, to })).rejects.toMatchObject({
      code: 'invalid_response',
      message: 'Google Calendar: invalid_response',
    });
  });

  it('rejects a response whose reported window fails to cover the request', async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(
      Response.json({ timeMin, timeMax: clockChange.end, calendars: { primary: { busy } } }),
    );
    await expect(client.queryBusy('current-access-token', { from, to })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('rejects a nonsensical request before contacting Google', async () => {
    const { client, fetch } = setup();
    await expect(
      client.queryBusy('current-access-token', { from, to: from }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Google Calendar event transport', () => {
  const calendarId = 'calendar@example.test';
  const event = {
    id: 'abcd01234',
    summary: 'Занятие TutorFlow',
    start: { dateTime: '2026-11-19T12:00:00Z' },
    end: { dateTime: '2026-11-19T13:00:00Z' },
    extendedProperties: { private: { tutorflow: 'synthetic-marker' } },
  };
  const etag = '"previous-revision"';
  const result = {
    ...event,
    etag: '"next-revision"',
    status: 'confirmed',
    htmlLink: 'https://www.google.com/calendar/event?eid=example',
  };

  it('sends only the supported event fields and returns a filtered event', async () => {
    const { client, fetch } = setup();
    const { start, extendedProperties } = event;
    const input = {
      ...event,
      description: 'a private note',
      attendees: [{ email: 'address@example.test' }],
      start: { ...start, additionalProperty: true },
      extendedProperties: { ...extendedProperties, shared: { accidental: 'private' } },
    };
    fetch.mockResolvedValueOnce(
      Response.json({
        ...result,
        description: 'a private note',
        organizer: { email: 'address@example.test' },
        extendedProperties: { ...extendedProperties, shared: { accidental: 'private' } },
      }),
    );
    await expect(client.insertEvent('current-access-token', calendarId, input)).resolves.toEqual({
      ...result,
      hasUnexpectedContent: true,
    });
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe(
      '/calendar/v3/calendars/calendar%40example.test/events',
    );
    expect(new URL(String(url)).searchParams.get('sendUpdates')).toBe('none');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(event);
  });

  it('requires the same ETag for each conditional write and recognizes a stale version', async () => {
    const { client, fetch } = setup();
    fetch
      .mockResolvedValueOnce(Response.json(result))
      .mockResolvedValueOnce(Response.json({ error: {} }, { status: 412 }));
    const patch = { summary: 'Занятие TutorFlow', attendees: [{ email: 'address@example.test' }] };
    await expect(
      client.patchEvent('current-access-token', calendarId, event.id, etag, patch),
    ).resolves.toEqual({ ...result, hasUnexpectedContent: false });
    await expect(
      client.deleteEvent('current-access-token', calendarId, event.id, etag),
    ).rejects.toMatchObject({ code: 'precondition_failed' });
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: 'PATCH',
      headers: { 'If-Match': etag },
      body: JSON.stringify({ summary: patch.summary }),
    });
    expect(fetch.mock.calls[1][1]).toMatchObject({
      method: 'DELETE',
      headers: { 'If-Match': etag },
    });
    for (const [url] of fetch.mock.calls) {
      expect(new URL(String(url)).pathname).toBe(
        '/calendar/v3/calendars/calendar%40example.test/events/' + event.id,
      );
      expect(new URL(String(url)).searchParams.get('sendUpdates')).toBe('none');
    }
  });

  it('patches only the TutorFlow revision marker among extended properties', async () => {
    const { client, fetch } = setup();
    const scope = { tutorflowEvent: 'new-revision-marker', unapproved: 'private details' };
    fetch.mockResolvedValueOnce(Response.json(result));
    const patch = {
      extendedProperties: {
        private: scope,
        shared: { unapproved: 'shared details' },
      },
    };
    await client.patchEvent('current-access-token', calendarId, event.id, etag, patch);
    expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({
      extendedProperties: { private: { tutorflowEvent: 'new-revision-marker' } },
    });
  });

  it('rejects markers that Google would truncate before modifying an event', async () => {
    const { client, fetch } = setup();
    await expect(
      client.patchEvent('current-access-token', calendarId, event.id, etag, {
        extendedProperties: { private: { tutorflowEvent: 'a'.repeat(1025) } },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a wildcard ETag before modifying a remote event', async () => {
    const { client, fetch } = setup();
    await expect(
      client.deleteEvent('current-access-token', calendarId, event.id, '*'),
    ).rejects.toMatchObject({ code: 'precondition_failed' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns a cancelled tombstone without requiring an ETag', async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(Response.json({ id: event.id, status: 'cancelled' }));
    await expect(client.getEvent('current-access-token', calendarId, event.id)).resolves.toEqual({
      id: event.id,
      status: 'cancelled',
      etag: null,
      hasUnexpectedContent: false,
    });
  });

  it('exposes an insert conflict as a fixed error for duplicate verification', async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(Response.json({ error: {} }, { status: 409 }));
    await expect(
      client.insertEvent('current-access-token', calendarId, event),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it.each([
    ['attendees', [{ email: 'address@example.test' }]],
    ['attendeesOmitted', true],
    ['description', 'private note'],
    ['location', 'private address'],
    ['recurrence', ['RRULE:FREQ=DAILY']],
    ['recurringEventId', 'recurrence-id'],
    ['conferenceData', { conferenceId: 'private meeting' }],
    ['hangoutLink', 'private meeting link'],
    ['attachments', [{ fileId: 'private file' }]],
  ])('reports manual %s edits without returning the detail', async (key, value) => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(Response.json({ ...result, [key]: value }));
    await expect(client.getEvent('current-access-token', calendarId, event.id)).resolves.toEqual({
      ...result,
      hasUnexpectedContent: true,
    });
    const fields = new URL(String(fetch.mock.calls[0][0])).searchParams.get('fields');
    expect(fields?.split(',')).toContain(key);
  });
});

describe('encrypted Google refresh tokens', () => {
  const key = Buffer.alloc(32, 7);
  const context = { ownerId: 'owner-a', googleSubject: 'google-a' };

  it('encrypts with a unique IV and binds authenticated decryption to the owner and Google subject', () => {
    const plaintext = 'synthetic-refresh-token';
    const first = encryptGoogleCalendarRefreshToken(plaintext, key, context);
    const second = encryptGoogleCalendarRefreshToken(plaintext, key, context);
    expect(first).not.toBe(second);
    expect(first).not.toContain(plaintext);
    expect(decryptGoogleCalendarRefreshToken(first, key, context)).toBe(plaintext);
    expect(() =>
      decryptGoogleCalendarRefreshToken(first, key, { ...context, ownerId: 'owner-b' }),
    ).toThrow('Google Calendar: invalid_token');
    expect(() =>
      decryptGoogleCalendarRefreshToken(first, key, { ...context, googleSubject: 'google-b' }),
    ).toThrow('Google Calendar: invalid_token');
    const [version, iv, tag, data] = first.split('.');
    const tampered = (data[0] === 'A' ? 'B' : 'A') + data.slice(1);
    expect(() =>
      decryptGoogleCalendarRefreshToken(`${version}.${iv}.${tag}.${tampered}`, key, context),
    ).toThrow('Google Calendar: invalid_token');
  });
});

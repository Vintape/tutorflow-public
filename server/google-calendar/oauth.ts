import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  randomBytes,
  verify,
} from 'node:crypto';
import { z } from 'zod';

const authorizationEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const revocationEndpoint = 'https://oauth2.googleapis.com/revoke';
const googleKeysEndpoint = 'https://www.googleapis.com/oauth2/v3/certs';
const calendarsEndpoint = 'https://www.googleapis.com/calendar/v3/calendars';
const freeBusyEndpoint = 'https://www.googleapis.com/calendar/v3/freeBusy';
const calendarScope = 'https://www.googleapis.com/auth/calendar.app.created';
const busyScope = 'https://www.googleapis.com/auth/calendar.freebusy';
const stateLifetimeMs = 10 * 60 * 1000;
const maxRetryAfterMs = 60 * 60 * 1000;
const maxResponseBytes = 64 * 1024;
const maxCredentialLength = 8192;
const clockSkewSeconds = 60;
const statePattern = /^[A-Za-z0-9_-]{43}$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const eventIdPattern = /^[0-9a-v]{5,1024}$/;
const calendarTimestamp = z.iso.datetime({ offset: true });
const eventStringFields = ['description', 'location', 'recurringEventId', 'hangoutLink'] as const;
const eventListFields = ['attendees', 'recurrence', 'attachments'] as const;
const eventFields = [
  'id',
  'etag',
  'status',
  'summary',
  'start(date,dateTime)',
  'end(date,dateTime)',
  'extendedProperties(private)',
  'htmlLink',
  ...eventStringFields,
  ...eventListFields,
  'attendeesOmitted',
  'conferenceData',
].join(',');

export type GoogleCalendarErrorCode =
  | 'invalid_configuration'
  | 'invalid_identity'
  | 'insufficient_scope'
  | 'missing_refresh_token'
  | 'invalid_grant'
  | 'invalid_client'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'precondition_failed'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_request'
  | 'invalid_response'
  | 'provider_error'
  | 'invalid_token';

export class GoogleCalendarError extends Error {
  constructor(
    readonly code: GoogleCalendarErrorCode,
    readonly retryAfterMs?: number,
  ) {
    super('Google Calendar: ' + code);
    this.name = 'GoogleCalendarError';
  }
}

export interface GoogleCalendarClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface GoogleCalendarAuthorization {
  authorizationUrl: string;
  stateHash: string;
  codeVerifier: string;
  nonce: string;
  expiresAt: Date;
}

export interface GoogleCalendarAccess {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
}

export interface GoogleCalendarGrant extends GoogleCalendarAccess {
  refreshToken: string;
  googleSubject: string;
  canReadBusy?: boolean;
}

export interface GoogleCalendarBusyInterval {
  start: string;
  end: string;
}

interface EventTime {
  date?: string;
  dateTime?: string;
}

export interface GoogleCalendarEvent {
  id: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  etag: string | null;
  hasUnexpectedContent: boolean;
  summary?: string;
  start?: EventTime;
  end?: EventTime;
  htmlLink?: string;
  extendedProperties?: { private?: Record<string, string> };
}

export interface GoogleCalendarEventInput {
  id: string;
  summary: string;
  start: { dateTime: string };
  end: { dateTime: string };
  extendedProperties: { private: Record<string, string> };
}

export type GoogleCalendarEventPatch = Partial<
  Pick<GoogleCalendarEventInput, 'summary' | 'start' | 'end'>
> & { extendedProperties?: { private: { tutorflowEvent: string } } };

export interface GoogleCalendarClient {
  beginAuthorization(options?: { includeBusy?: boolean }): GoogleCalendarAuthorization;
  exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
    nonce: string;
    requireBusy?: boolean;
  }): Promise<GoogleCalendarGrant>;
  refreshAccessToken(refreshToken: string): Promise<GoogleCalendarAccess>;
  createCalendar(accessToken: string, timeZone: string): Promise<{ id: string }>;
  getCalendar(accessToken: string, calendarId: string): Promise<{ id: string }>;
  revokeRefreshToken(refreshToken: string): Promise<void>;
  queryBusy(
    accessToken: string,
    range: { from: string; to: string },
  ): Promise<GoogleCalendarBusyInterval[]>;
  getEvent(accessToken: string, calendarId: string, eventId: string): Promise<GoogleCalendarEvent>;
  insertEvent(
    accessToken: string,
    calendarId: string,
    event: GoogleCalendarEventInput,
  ): Promise<GoogleCalendarEvent>;
  patchEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    etag: string,
    event: GoogleCalendarEventPatch,
  ): Promise<GoogleCalendarEvent>;
  deleteEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    etag: string,
  ): Promise<void>;
}

interface TokenContext {
  ownerId: string;
  googleSubject: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCredential(value: unknown): value is string {
  return typeof value === 'string' && value.length <= maxCredentialLength && /^[!-~]+$/.test(value);
}

function newStateValue(): string {
  return randomBytes(32).toString('base64url');
}

function digest(value: string) {
  return createHash('sha256').update(value);
}

export function hashGoogleCalendarState(state: string): string | null {
  return statePattern.test(state) ? digest(state).digest('hex') : null;
}

function validateRedirectUri(value: string): void {
  const url = URL.parse(value);
  if (!url || url.username || url.password || value.includes('?') || value.includes('#')) {
    throw new GoogleCalendarError('invalid_configuration');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new GoogleCalendarError('invalid_configuration');
  }
}

function mapError(status: number, body: unknown): GoogleCalendarErrorCode {
  const error = isRecord(body) ? body.error : undefined;
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'unavailable';
  if (typeof error === 'string') {
    if (
      ['invalid_grant', 'invalid_client', 'invalid_token', 'insufficient_scope'].includes(error)
    ) {
      return error as GoogleCalendarErrorCode;
    }
  }
  if (status === 401) return 'unauthorized';
  if (status === 409) return 'conflict';
  if (status === 412) return 'precondition_failed';
  if (status === 403) {
    const reasons = isRecord(error) && Array.isArray(error.errors) ? error.errors : [];
    return reasons.some(
      (entry: unknown) =>
        isRecord(entry) &&
        (entry.reason === 'rateLimitExceeded' || entry.reason === 'userRateLimitExceeded'),
    )
      ? 'rate_limited'
      : 'forbidden';
  }
  if (status === 404 || status === 410) return 'not_found';
  return 'provider_error';
}

function parseRetryAfter(header: string | null, now: number): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Math.min(maxRetryAfterMs, Number(value) * 1000);
  if (value.length > 64 || !/^[A-Za-z]{3}/.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(maxRetryAfterMs, Math.max(0, date - now)) : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxResponseBytes) {
      void reader.cancel().catch(() => {});
      throw new GoogleCalendarError('invalid_response');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function requireScopes(scope: unknown, mode: 'calendar' | 'busy' | 'refresh'): void {
  if (mode === 'refresh' && scope === undefined) return;
  const scopes = typeof scope === 'string' ? scope.trim().split(/\s+/) : [];
  if (
    !scopes.includes(calendarScope) ||
    (mode !== 'refresh' && !scopes.includes('openid')) ||
    (mode === 'busy' && !scopes.includes(busyScope)) ||
    scopes.some((value) => value !== calendarScope && value !== 'openid' && value !== busyScope)
  ) {
    throw new GoogleCalendarError('insufficient_scope');
  }
}

function readAccessToken(body: Record<string, unknown>, requestedAt: number): GoogleCalendarAccess {
  if (
    !isCredential(body.access_token) ||
    body.token_type !== 'Bearer' ||
    typeof body.expires_in !== 'number' ||
    !Number.isSafeInteger(body.expires_in) ||
    body.expires_in <= 0 ||
    (body.refresh_token !== undefined && !isCredential(body.refresh_token))
  ) {
    throw new GoogleCalendarError('invalid_response');
  }
  const expiresAt = new Date(requestedAt + body.expires_in * 1000);
  if (!Number.isFinite(expiresAt.getTime())) throw new GoogleCalendarError('invalid_response');
  return {
    accessToken: body.access_token,
    expiresAt,
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
  };
}

function parseJwtPart(part: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (isRecord(value)) return value;
  } catch {
    // JWT parsing details and input are intentionally omitted.
  }
  throw new GoogleCalendarError('invalid_identity');
}

function verifyGoogleSignature(jwk: Record<string, unknown>, content: string, signature: string) {
  if (
    jwk.kty !== 'RSA' ||
    (jwk.alg !== undefined && jwk.alg !== 'RS256') ||
    (jwk.use !== undefined && jwk.use !== 'sig') ||
    typeof jwk.n !== 'string' ||
    typeof jwk.e !== 'string'
  ) {
    return false;
  }
  try {
    const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    return verify(
      'RSA-SHA256',
      Buffer.from(content, 'ascii'),
      key,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

function validateIdentityClaims(
  claims: Record<string, unknown>,
  clientId: string,
  nonce: string,
  accessToken: string,
  nowSeconds: number,
): string {
  const { iss, sub, aud, azp, iat, exp, at_hash: accessTokenHash } = claims;
  if (
    (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') ||
    aud !== clientId ||
    (azp !== undefined && azp !== clientId) ||
    claims.nonce !== nonce ||
    typeof sub !== 'string' ||
    !/^[!-~]{1,255}$/.test(sub) ||
    typeof iat !== 'number' ||
    !Number.isSafeInteger(iat) ||
    iat <= 0 ||
    iat > nowSeconds + clockSkewSeconds ||
    typeof exp !== 'number' ||
    !Number.isSafeInteger(exp) ||
    exp <= nowSeconds ||
    exp <= iat ||
    (accessTokenHash !== undefined &&
      accessTokenHash !== digest(accessToken).digest().subarray(0, 16).toString('base64url'))
  ) {
    throw new GoogleCalendarError('invalid_identity');
  }
  return sub;
}

function requireCalendarId(value: unknown): string {
  if (
    !isCredential(value) ||
    value.length > 1024 ||
    value === '.' ||
    value === '..' ||
    value === 'primary'
  ) {
    throw new GoogleCalendarError('invalid_response');
  }
  return value;
}

function bearerHeaders(accessToken: string) {
  if (!isCredential(accessToken)) throw new GoogleCalendarError('invalid_token');
  return { Authorization: 'Bearer ' + accessToken };
}

function parseCalendarTime(value: unknown, code: 'invalid_request' | 'invalid_response'): number {
  const parsed = calendarTimestamp.safeParse(value);
  if (!parsed.success) throw new GoogleCalendarError(code);
  const time = Date.parse(parsed.data);
  if (!Number.isFinite(time)) throw new GoogleCalendarError(code);
  return time;
}

function readBusy(
  response: Record<string, unknown>,
  from: number,
  to: number,
): GoogleCalendarBusyInterval[] {
  const reportedFrom = parseCalendarTime(response.timeMin, 'invalid_response');
  const reportedTo = parseCalendarTime(response.timeMax, 'invalid_response');
  // Google can resolve the sole requested "primary" alias to a calendar ID.
  const calendars = isRecord(response.calendars) ? Object.values(response.calendars) : [];
  const [primary] = calendars;
  if (
    reportedFrom > from ||
    reportedTo < to ||
    calendars.length !== 1 ||
    (response.groups !== undefined &&
      (!isRecord(response.groups) || Object.keys(response.groups).length > 0)) ||
    !isRecord(primary) ||
    !Array.isArray(primary.busy) ||
    (primary.errors !== undefined && (!Array.isArray(primary.errors) || primary.errors.length > 0))
  ) {
    throw new GoogleCalendarError('invalid_response');
  }

  const busy: GoogleCalendarBusyInterval[] = [];
  for (const interval of primary.busy as unknown[]) {
    if (!isRecord(interval)) throw new GoogleCalendarError('invalid_response');
    const start = parseCalendarTime(interval.start, 'invalid_response');
    const end = parseCalendarTime(interval.end, 'invalid_response');
    if (start >= end) throw new GoogleCalendarError('invalid_response');
    const clippedStart = Math.max(start, from);
    const clippedEnd = Math.min(end, to);
    if (clippedStart < clippedEnd) {
      busy.push({
        start: new Date(clippedStart).toISOString(),
        end: new Date(clippedEnd).toISOString(),
      });
    }
  }
  return busy.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

function isStrongEtag(value: unknown): value is string {
  return typeof value === 'string' && /^"[!#-~]{1,1024}"$/.test(value);
}

function conditionalHeaders(accessToken: string, etag: string) {
  if (!isStrongEtag(etag)) throw new GoogleCalendarError('precondition_failed');
  return { ...bearerHeaders(accessToken), 'If-Match': etag };
}

function eventEndpoint(calendarId: string, method: string, eventId?: string): string {
  const calendarPath = calendarsEndpoint + '/' + encodeURIComponent(requireCalendarId(calendarId));
  if (eventId !== undefined && !eventIdPattern.test(eventId)) {
    throw new GoogleCalendarError('invalid_response');
  }
  const url = new URL(calendarPath + '/events' + (eventId === undefined ? '' : '/' + eventId));
  if (method !== 'DELETE') url.searchParams.set('fields', eventFields);
  if (method !== 'GET') url.searchParams.set('sendUpdates', 'none');
  return url.toString();
}

function readEventTime(value: unknown): EventTime | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.dateTime === 'string') return { dateTime: value.dateTime };
  if (typeof value.date === 'string') return { date: value.date };
  return undefined;
}

function readEventLink(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const url = URL.parse(value);
  if (
    url &&
    !url.username &&
    !url.password &&
    (url.origin === 'https://www.google.com' || url.origin === 'https://calendar.google.com') &&
    url.pathname.startsWith('/calendar/')
  ) {
    return url.href;
  }
  return undefined;
}

function hasUnexpectedEventContent(response: Record<string, unknown>): boolean {
  return (
    response.attendeesOmitted === true ||
    eventStringFields.some(
      (field) => typeof response[field] === 'string' && response[field].length > 0,
    ) ||
    eventListFields.some((field) => Array.isArray(response[field]) && response[field].length > 0) ||
    (isRecord(response.conferenceData) && Object.keys(response.conferenceData).length > 0)
  );
}

function readEvent(response: Record<string, unknown>, id: string): GoogleCalendarEvent {
  const status = response.status ?? 'confirmed';
  const etag = isStrongEtag(response.etag) ? response.etag : null;
  if (
    response.id !== id ||
    (status !== 'confirmed' && status !== 'tentative' && status !== 'cancelled') ||
    (etag === null && status !== 'cancelled')
  ) {
    throw new GoogleCalendarError('invalid_response');
  }
  const event: GoogleCalendarEvent = {
    id,
    status,
    etag,
    hasUnexpectedContent: hasUnexpectedEventContent(response),
  };
  const start = readEventTime(response.start);
  const end = readEventTime(response.end);
  const htmlLink = readEventLink(response.htmlLink);
  if (start) event.start = start;
  if (end) event.end = end;
  if (htmlLink) event.htmlLink = htmlLink;
  if (typeof response.summary === 'string') event.summary = response.summary;
  if (isRecord(response.extendedProperties) && isRecord(response.extendedProperties.private)) {
    const properties = Object.entries(response.extendedProperties.private).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    );
    event.extendedProperties = { private: Object.fromEntries(properties) };
  }
  return event;
}

export function createGoogleCalendarClient(
  config: GoogleCalendarClientConfig,
): GoogleCalendarClient {
  const {
    clientId,
    clientSecret,
    redirectUri,
    fetch = globalThis.fetch,
    now = Date.now,
    timeoutMs = 8000,
  } = config;
  validateRedirectUri(redirectUri);
  if (!isCredential(clientId) || !isCredential(clientSecret)) {
    throw new GoogleCalendarError('invalid_configuration');
  }

  async function request(
    endpoint: string,
    init: RequestInit,
    expectBody = true,
  ): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(endpoint, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
        cache: 'no-store',
      });
      if ((response.ok && !expectBody) || response.status === 429 || response.status >= 500) {
        void response.body?.cancel().catch(() => {});
        if (response.ok) return {};
        throw new GoogleCalendarError(
          mapError(response.status, undefined),
          parseRetryAfter(response.headers.get('Retry-After'), now()),
        );
      }
      const body = await readJson(response);
      if (!response.ok) {
        throw new GoogleCalendarError(
          mapError(response.status, body),
          parseRetryAfter(response.headers.get('Retry-After'), now()),
        );
      }
      if (!isRecord(body)) throw new GoogleCalendarError('invalid_response');
      return body;
    } catch (error) {
      if (error instanceof GoogleCalendarError) throw error;
      throw new GoogleCalendarError('unavailable');
    }
  }

  function postForm(endpoint: string, fields: Record<string, string>, expectBody = true) {
    return request(endpoint, { method: 'POST', body: new URLSearchParams(fields) }, expectBody);
  }

  async function verifyIdentity(
    idToken: unknown,
    nonce: string,
    accessToken: string,
  ): Promise<string> {
    if (!isCredential(idToken)) throw new GoogleCalendarError('invalid_identity');
    const parts = idToken.split('.');
    if (parts.length !== 3 || parts.some((part) => !base64UrlPattern.test(part))) {
      throw new GoogleCalendarError('invalid_identity');
    }
    const [headerPart, payloadPart, signature] = parts;
    const header = parseJwtPart(headerPart);
    if (header.alg !== 'RS256' || !isCredential(header.kid)) {
      throw new GoogleCalendarError('invalid_identity');
    }
    // Only Google's fixed JWKS endpoint supplies keys, never a URL or key provided by the JWT.
    const { keys } = await request(googleKeysEndpoint, { method: 'GET' });
    if (!Array.isArray(keys)) throw new GoogleCalendarError('invalid_response');
    const jwk: unknown = keys.find((entry: unknown) => isRecord(entry) && entry.kid === header.kid);
    if (!isRecord(jwk) || !verifyGoogleSignature(jwk, headerPart + '.' + payloadPart, signature)) {
      throw new GoogleCalendarError('invalid_identity');
    }
    return validateIdentityClaims(
      parseJwtPart(payloadPart),
      clientId,
      nonce,
      accessToken,
      Math.floor(now() / 1000),
    );
  }

  return {
    beginAuthorization({ includeBusy = false } = {}) {
      const state = newStateValue();
      const codeVerifier = newStateValue();
      const nonce = newStateValue();
      const url = new URL(authorizationEndpoint);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: ['openid', calendarScope, ...(includeBusy ? [busyScope] : [])].join(' '),
        response_type: 'code',
        access_type: 'offline',
        prompt: 'consent select_account',
        state,
        code_challenge: digest(codeVerifier).digest('base64url'),
        code_challenge_method: 'S256',
        nonce,
      }).toString();
      return {
        authorizationUrl: url.toString(),
        stateHash: digest(state).digest('hex'),
        codeVerifier,
        nonce,
        expiresAt: new Date(now() + stateLifetimeMs),
      };
    },

    async exchangeAuthorizationCode({ code, codeVerifier, nonce, requireBusy = false }) {
      if (!isCredential(code) || !statePattern.test(codeVerifier) || !statePattern.test(nonce)) {
        throw new GoogleCalendarError('invalid_grant');
      }
      const requestedAt = now();
      const response = await postForm(tokenEndpoint, {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
        code_verifier: codeVerifier,
      });
      requireScopes(response.scope, requireBusy ? 'busy' : 'calendar');
      const access = readAccessToken(response, requestedAt);
      if (!access.refreshToken) throw new GoogleCalendarError('missing_refresh_token');
      const googleSubject = await verifyIdentity(response.id_token, nonce, access.accessToken);
      return {
        ...access,
        refreshToken: access.refreshToken,
        googleSubject,
        canReadBusy: requireBusy,
      };
    },

    async refreshAccessToken(refreshToken) {
      if (!isCredential(refreshToken)) throw new GoogleCalendarError('invalid_token');
      const requestedAt = now();
      const response = await postForm(tokenEndpoint, {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      requireScopes(response.scope, 'refresh');
      return readAccessToken(response, requestedAt);
    },

    async createCalendar(accessToken, timeZone) {
      const response = await request(calendarsEndpoint, {
        method: 'POST',
        headers: { ...bearerHeaders(accessToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: 'TutorFlow', timeZone }),
      });
      return { id: requireCalendarId(response.id) };
    },

    async getCalendar(accessToken, calendarId) {
      const requestedId = requireCalendarId(calendarId);
      const response = await request(calendarsEndpoint + '/' + encodeURIComponent(requestedId), {
        method: 'GET',
        headers: bearerHeaders(accessToken),
      });
      if (response.id !== requestedId) throw new GoogleCalendarError('invalid_response');
      return { id: requestedId };
    },

    async revokeRefreshToken(refreshToken) {
      if (!isCredential(refreshToken)) throw new GoogleCalendarError('invalid_token');
      await postForm(revocationEndpoint, { token: refreshToken }, false);
    },

    async queryBusy(accessToken, range) {
      const from = parseCalendarTime(range.from, 'invalid_request');
      const to = parseCalendarTime(range.to, 'invalid_request');
      if (from >= to) throw new GoogleCalendarError('invalid_request');
      // Query full seconds, then clip to the caller's bounds without losing fractional edges.
      const response = await request(freeBusyEndpoint, {
        method: 'POST',
        headers: { ...bearerHeaders(accessToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeMin: new Date(Math.floor(from / 1000) * 1000).toISOString(),
          timeMax: new Date(Math.ceil(to / 1000) * 1000).toISOString(),
          items: [{ id: 'primary' }],
        }),
      });
      return readBusy(response, from, to);
    },

    async getEvent(accessToken, calendarId, eventId) {
      const response = await request(eventEndpoint(calendarId, 'GET', eventId), {
        method: 'GET',
        headers: bearerHeaders(accessToken),
      });
      return readEvent(response, eventId);
    },

    async insertEvent(accessToken, calendarId, event) {
      if (!eventIdPattern.test(event.id)) throw new GoogleCalendarError('invalid_response');
      const response = await request(eventEndpoint(calendarId, 'POST'), {
        method: 'POST',
        headers: { ...bearerHeaders(accessToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: event.id,
          summary: event.summary,
          start: { dateTime: event.start.dateTime },
          end: { dateTime: event.end.dateTime },
          extendedProperties: { private: event.extendedProperties.private },
        }),
      });
      return readEvent(response, event.id);
    },

    async patchEvent(accessToken, calendarId, eventId, etag, event) {
      const marker = event.extendedProperties?.private?.tutorflowEvent;
      if (event.extendedProperties && (!isCredential(marker) || marker.length > 1024)) {
        throw new GoogleCalendarError('invalid_request');
      }
      const response = await request(eventEndpoint(calendarId, 'PATCH', eventId), {
        method: 'PATCH',
        headers: { ...conditionalHeaders(accessToken, etag), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: event.summary,
          start: event.start && { dateTime: event.start.dateTime },
          end: event.end && { dateTime: event.end.dateTime },
          extendedProperties:
            marker === undefined ? undefined : { private: { tutorflowEvent: marker } },
        }),
      });
      return readEvent(response, eventId);
    },

    async deleteEvent(accessToken, calendarId, eventId, etag) {
      await request(
        eventEndpoint(calendarId, 'DELETE', eventId),
        { method: 'DELETE', headers: conditionalHeaders(accessToken, etag) },
        false,
      );
    },
  };
}

function tokenContext(context: TokenContext): Buffer {
  return Buffer.from(
    JSON.stringify([
      'TutorFlow Google Calendar refresh token v1',
      context.ownerId,
      context.googleSubject,
    ]),
  );
}

function requireEncryptionKey(key: Uint8Array) {
  if (key.byteLength !== 32) throw new GoogleCalendarError('invalid_configuration');
}

export function encryptGoogleCalendarRefreshToken(
  refreshToken: string,
  key: Uint8Array,
  context: TokenContext,
): string {
  requireEncryptionKey(key);
  if (!isCredential(refreshToken)) throw new GoogleCalendarError('invalid_token');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(tokenContext(context));
  const ciphertext = Buffer.concat([cipher.update(refreshToken, 'utf8'), cipher.final()]);
  return [
    'v1',
    ...[iv, cipher.getAuthTag(), ciphertext].map((bytes) => bytes.toString('base64url')),
  ].join('.');
}

export function decryptGoogleCalendarRefreshToken(
  encrypted: string,
  key: Uint8Array,
  context: TokenContext,
): string {
  requireEncryptionKey(key);
  if (encrypted.length > 4 * Math.ceil(maxCredentialLength / 3) + 42) {
    throw new GoogleCalendarError('invalid_token');
  }
  const [version, ...data] = encrypted.split('.');
  if (
    version !== 'v1' ||
    data.length !== 3 ||
    data[0].length !== 16 ||
    data[1].length !== 22 ||
    data.some((part) => !base64UrlPattern.test(part))
  ) {
    throw new GoogleCalendarError('invalid_token');
  }
  const [iv, tag, ciphertext] = data.map((part) => Buffer.from(part, 'base64url'));
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(tokenContext(context));
    cipher.setAuthTag(tag);
    const refreshToken = Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString(
      'utf8',
    );
    if (isCredential(refreshToken)) return refreshToken;
  } catch {
    // Expose one error for malformed, tampered, or wrong-context ciphertexts.
  }
  throw new GoogleCalendarError('invalid_token');
}

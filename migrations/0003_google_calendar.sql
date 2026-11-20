CREATE TABLE google_calendar_connections (
  "ownerId" text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  id text NOT NULL UNIQUE,
  "googleSubject" text NOT NULL,
  "refreshCiphertext" text,
  "calendarId" text,
  status text NOT NULL CHECK (status IN ('pending_calendar', 'calendar_uncertain', 'ready', 'connected', 'needs_reconnect', 'disconnected')),
  "needsReview" boolean NOT NULL DEFAULT false,
  "canReadBusy" boolean NOT NULL DEFAULT false,
  "calendarClaim" text,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("ownerId", id),
  CHECK (status NOT IN ('connected', 'ready') OR "calendarId" IS NOT NULL)
);
-- statement-breakpoint
CREATE TABLE google_calendar_oauth_states (
  "ownerId" text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  "sessionId" text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  "stateHash" text NOT NULL UNIQUE,
  "codeVerifier" text NOT NULL,
  nonce text NOT NULL,
  "includeBusy" boolean NOT NULL DEFAULT false,
  "consumedAt" timestamptz,
  "expiresAt" timestamptz NOT NULL
);

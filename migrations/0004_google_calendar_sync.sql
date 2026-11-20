CREATE TABLE google_calendar_sync (
  "ownerId" text NOT NULL,
  "connectionId" text NOT NULL,
  "lessonId" text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  "eventId" text NOT NULL UNIQUE CHECK (length("eventId") BETWEEN 5 AND 1024 AND "eventId" ~ '^[0-9a-v]+$'),
  "desiredAction" text NOT NULL CHECK ("desiredAction" IN ('upsert', 'delete')),
  "desiredVersion" integer NOT NULL CHECK ("desiredVersion" > 0),
  "startsAt" timestamptz NOT NULL,
  duration integer NOT NULL CHECK (duration BETWEEN 15 AND 480),
  "appliedVersion" integer CHECK ("appliedVersion" > 0),
  etag text,
  "eventLink" text,
  candidate jsonb,
  "restoreRequested" boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'synced', 'needs_review', 'dismissed', 'paused')),
  reason text CHECK (reason IN ('remote_changed', 'remote_missing', 'ownership_mismatch',
    'provider_rejected', 'retry_exhausted', 'offline_cancellation')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  "nextAttemptAt" timestamptz NOT NULL DEFAULT now(),
  "leaseToken" text,
  "leaseUntil" timestamptz,
  PRIMARY KEY ("ownerId", "connectionId", "lessonId", generation),
  FOREIGN KEY ("ownerId", "connectionId")
    REFERENCES google_calendar_connections ("ownerId", id) ON DELETE CASCADE,
  FOREIGN KEY ("ownerId", "lessonId") REFERENCES lessons ("ownerId", id) ON DELETE CASCADE,
  CHECK (("leaseToken" IS NULL) = ("leaseUntil" IS NULL))
);
-- statement-breakpoint
CREATE INDEX google_calendar_sync_due_idx ON google_calendar_sync ("nextAttemptAt")
  WHERE state = 'pending';

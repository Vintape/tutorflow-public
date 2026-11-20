CREATE TABLE "user" (
  id text PRIMARY KEY, name text NOT NULL, email text UNIQUE NOT NULL,
  "emailVerified" boolean NOT NULL DEFAULT false, image text,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
-- statement-breakpoint
CREATE TABLE session (
  id text PRIMARY KEY, token text UNIQUE NOT NULL, "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text, "userAgent" text, "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE INDEX session_user_idx ON session ("userId");
-- statement-breakpoint
CREATE TABLE account (
  id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken" text, "refreshToken" text, "idToken" text,
  "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
  scope text, password text,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("providerId", "accountId")
);
-- statement-breakpoint
CREATE INDEX account_user_idx ON account ("userId");
-- statement-breakpoint
CREATE TABLE verification (
  id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
-- statement-breakpoint
CREATE INDEX verification_identifier_idx ON verification (identifier);
-- statement-breakpoint
CREATE TABLE settings (
  "ownerId" text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'Europe/Moscow', theme text NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'dark', 'system'))
);
-- statement-breakpoint
CREATE TABLE students (
  id text PRIMARY KEY, "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100), subject text NOT NULL, level text NOT NULL DEFAULT '',
  price integer NOT NULL CHECK (price BETWEEN 0 AND 100000000), duration integer NOT NULL CHECK (duration BETWEEN 15 AND 480),
  goal text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '', "archivedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("ownerId", id)
);
-- statement-breakpoint
CREATE INDEX students_owner_idx ON students ("ownerId", "archivedAt");
-- statement-breakpoint
CREATE TABLE lessons (
  id text PRIMARY KEY, "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "studentId" text NOT NULL, "startsAt" timestamptz NOT NULL,
  duration integer NOT NULL CHECK (duration BETWEEN 15 AND 480), price integer NOT NULL CHECK (price BETWEEN 0 AND 100000000),
  topic text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'COMPLETED', 'CANCELLED')),
  note text NOT NULL DEFAULT '', homework text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("ownerId", id),
  FOREIGN KEY ("ownerId", "studentId") REFERENCES students ("ownerId", id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE INDEX lessons_owner_date_idx ON lessons ("ownerId", "startsAt");
-- statement-breakpoint
CREATE INDEX lessons_student_date_idx ON lessons ("ownerId", "studentId", "startsAt");
-- statement-breakpoint
CREATE TABLE reports (
  id text PRIMARY KEY, "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "lessonId" text UNIQUE NOT NULL, content jsonb NOT NULL,
  "originalNote" text NOT NULL DEFAULT '', source text NOT NULL CHECK (source IN ('MANUAL', 'AI')),
  style text NOT NULL DEFAULT 'standard' CHECK (style IN ('short', 'standard', 'detailed')),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED')), version integer NOT NULL DEFAULT 1,
  "generatedAt" timestamptz, "approvedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY ("ownerId", "lessonId") REFERENCES lessons ("ownerId", id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE INDEX reports_owner_status_idx ON reports ("ownerId", status);
-- statement-breakpoint
CREATE TABLE payments (
  id text PRIMARY KEY, "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "lessonId" text NOT NULL, amount integer NOT NULL CHECK (amount > 0),
  "paidAt" timestamptz NOT NULL, "voidedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY ("ownerId", "lessonId") REFERENCES lessons ("ownerId", id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE UNIQUE INDEX payments_one_active_idx ON payments ("lessonId") WHERE "voidedAt" IS NULL;
-- statement-breakpoint
CREATE INDEX payments_owner_date_idx ON payments ("ownerId", "paidAt");
-- statement-breakpoint
CREATE TABLE ai_usage (
  id text PRIMARY KEY, "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
-- statement-breakpoint
CREATE INDEX ai_usage_owner_date_idx ON ai_usage ("ownerId", "createdAt");
-- statement-breakpoint
CREATE TABLE pilot_events (
  id text PRIMARY KEY, "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('report_created', 'report_approved', 'report_copied')),
  "elapsedMs" integer CHECK ("elapsedMs" BETWEEN 0 AND 86400000),
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

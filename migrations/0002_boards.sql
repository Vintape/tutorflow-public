CREATE TABLE boards (
  id text PRIMARY KEY,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200 AND title ~ '[^[:space:]]'),
  state text NOT NULL DEFAULT 'CREATING' CHECK (state IN ('CREATING', 'ACTIVE', 'DELETED')),
  "requestId" uuid NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("ownerId", id),
  UNIQUE ("ownerId", "requestId")
);
-- statement-breakpoint
CREATE INDEX boards_owner_state_idx ON boards ("ownerId", state, "updatedAt");
-- statement-breakpoint
CREATE TABLE board_students (
  "boardId" text NOT NULL,
  "ownerId" text NOT NULL,
  "studentId" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("boardId", "studentId"),
  FOREIGN KEY ("ownerId", "boardId") REFERENCES boards ("ownerId", id) ON DELETE CASCADE,
  FOREIGN KEY ("ownerId", "studentId") REFERENCES students ("ownerId", id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE INDEX board_students_student_idx ON board_students ("ownerId", "studentId");
-- statement-breakpoint
CREATE TABLE board_lessons (
  "boardId" text NOT NULL,
  "ownerId" text NOT NULL,
  "lessonId" text NOT NULL,
  -- Reserved reference only; immutable history storage/validation is a later migration.
  "snapshotId" text CHECK ("snapshotId" IS NULL OR length("snapshotId") BETWEEN 1 AND 200),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("boardId", "lessonId"),
  FOREIGN KEY ("ownerId", "boardId") REFERENCES boards ("ownerId", id) ON DELETE CASCADE,
  FOREIGN KEY ("ownerId", "lessonId") REFERENCES lessons ("ownerId", id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE INDEX board_lessons_lesson_idx ON board_lessons ("ownerId", "lessonId");
-- statement-breakpoint
CREATE TABLE board_invitations (
  id text PRIMARY KEY,
  "ownerId" text NOT NULL,
  "boardId" text NOT NULL,
  role text NOT NULL CHECK (role IN ('editor', 'viewer')),
  "tokenDigest" text UNIQUE NOT NULL CHECK ("tokenDigest" ~ '^[0-9a-f]{64}$'),
  "expiresAt" timestamptz NOT NULL,
  "maxUses" integer NOT NULL DEFAULT 1 CHECK ("maxUses" BETWEEN 1 AND 1000),
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0 AND uses <= "maxUses"),
  "revokedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CHECK ("expiresAt" > "createdAt"),
  UNIQUE ("ownerId", "boardId", id, role),
  FOREIGN KEY ("ownerId", "boardId") REFERENCES boards ("ownerId", id) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE INDEX board_invitations_board_idx ON board_invitations ("ownerId", "boardId");
-- statement-breakpoint
CREATE TABLE board_guest_sessions (
  id text PRIMARY KEY,
  "ownerId" text NOT NULL,
  "boardId" text NOT NULL,
  "invitationId" text NOT NULL,
  role text NOT NULL CHECK (role IN ('editor', 'viewer')),
  "tokenDigest" text UNIQUE NOT NULL CHECK ("tokenDigest" ~ '^[0-9a-f]{64}$'),
  "expiresAt" timestamptz NOT NULL,
  "revokedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CHECK ("expiresAt" > "createdAt"),
  FOREIGN KEY ("ownerId", "boardId") REFERENCES boards ("ownerId", id) ON DELETE CASCADE,
  FOREIGN KEY ("ownerId", "boardId", "invitationId", role)
    REFERENCES board_invitations ("ownerId", "boardId", id, role) ON DELETE CASCADE
);
-- statement-breakpoint
CREATE INDEX board_guest_sessions_invitation_idx ON board_guest_sessions ("ownerId", "boardId", "invitationId");

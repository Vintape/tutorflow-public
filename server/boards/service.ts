import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  boardCreateInput,
  boardInviteInput,
  boardLinkInput,
  boardRenameInput,
  type Board,
  type BoardCreateInput,
  type BoardGuestSession,
  type BoardInvitation,
  type BoardInviteInput,
  type BoardLinkInput,
  type BoardLinks,
  type BoardRedemption,
  type LessonBoard,
} from '../../shared/boards.js';
import type { Database, SQL } from '../db.js';
import { AppError, assertFound } from '../errors.js';

const boardColumns = 'id, "ownerId", title, state, "requestId", "createdAt", "updatedAt"';
const inviteColumns = 'id, "boardId", role, "expiresAt", "maxUses", uses, "revokedAt", "createdAt"';
const guestColumns = 's.id, s."boardId", s.role, s."expiresAt"';
const guestSecretPattern = /^[0-9a-f]{64}$/;
function digest(token: string): string {
  if (!guestSecretPattern.test(token)) throw new AppError(404, 'Запись не найдена', 'NOT_FOUND');
  return createHash('sha256').update(token).digest('hex');
}

export class BoardService {
  constructor(public db: Database) {}

  private async owned(
    owner: string,
    id: string,
    tx: SQL = this.db,
    lock = false,
    deleted = false,
  ): Promise<Board> {
    return assertFound(
      (
        await tx.query<Board>(
          `SELECT ${boardColumns} FROM boards WHERE "ownerId"=$1 AND id=$2 ${deleted ? '' : "AND state!='DELETED'"} ${lock ? 'FOR UPDATE' : ''}`,
          [owner, id],
        )
      )[0],
    );
  }

  async create(owner: string, input: BoardCreateInput): Promise<Board> {
    const data = boardCreateInput.parse(input);
    const created = assertFound(
      (
        await this.db.query<Board>(
          `INSERT INTO boards (id,"ownerId",title,"requestId") VALUES ($1,$2,$3,$4)
       ON CONFLICT ("ownerId","requestId") DO UPDATE SET id=boards.id RETURNING ${boardColumns}`,
          [randomUUID(), owner, data.title, data.requestId],
        )
      )[0],
    );
    if (created.state === 'DELETED') throw new AppError(404, 'Запись не найдена', 'NOT_FOUND');
    return created;
  }

  async activate(owner: string, id: string): Promise<Board> {
    return assertFound(
      (
        await this.db.query<Board>(
          `UPDATE boards SET state='ACTIVE', "updatedAt"=CASE WHEN state='CREATING' THEN clock_timestamp() ELSE "updatedAt" END
       WHERE "ownerId"=$1 AND id=$2 AND state!='DELETED' RETURNING ${boardColumns}`,
          [owner, id],
        )
      )[0],
    );
  }

  async get(owner: string, id: string): Promise<Board> {
    return this.owned(owner, id);
  }

  async list(owner: string): Promise<Board[]> {
    return this.db.query<Board>(
      `SELECT ${boardColumns} FROM boards WHERE "ownerId"=$1 AND state!='DELETED' ORDER BY "updatedAt" DESC, id`,
      [owner],
    );
  }

  async forLesson(owner: string, lessonId: string): Promise<LessonBoard[]> {
    const rows = await this.db.query<{
      id: string | null;
      title: string | null;
      snapshotId: string | null;
    }>(
      `SELECT linked.id,linked.title,linked."snapshotId"
       FROM lessons l
       LEFT JOIN (
         SELECT b.id,b.title,bl."snapshotId",bl."lessonId",bl."ownerId"
         FROM board_lessons bl JOIN boards b ON b.id=bl."boardId" AND b."ownerId"=bl."ownerId"
         WHERE b.state='ACTIVE'
       ) linked ON linked."lessonId"=l.id AND linked."ownerId"=l."ownerId"
       WHERE l."ownerId"=$1 AND l.id=$2 ORDER BY linked.title,linked.id`,
      [owner, lessonId],
    );
    assertFound(rows[0]);
    return rows.flatMap((row) =>
      row.id !== null && row.title !== null
        ? [{ id: row.id, title: row.title, snapshotId: row.snapshotId }]
        : [],
    );
  }

  async rename(owner: string, id: string, title: string): Promise<Board> {
    const data = boardRenameInput.parse({ title });
    return assertFound(
      (
        await this.db.query<Board>(
          `UPDATE boards SET title=$3,"updatedAt"=clock_timestamp() WHERE "ownerId"=$1 AND id=$2 AND state!='DELETED' RETURNING ${boardColumns}`,
          [owner, id, data.title],
        )
      )[0],
    );
  }

  async remove(owner: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.owned(owner, id, tx, true, true);
      await tx.query(
        `UPDATE boards SET state='DELETED',"updatedAt"=CASE WHEN state!='DELETED' THEN clock_timestamp() ELSE "updatedAt" END WHERE "ownerId"=$1 AND id=$2`,
        [owner, id],
      );
      await tx.query(
        'UPDATE board_invitations SET "revokedAt"=COALESCE("revokedAt",clock_timestamp()) WHERE "ownerId"=$1 AND "boardId"=$2',
        [owner, id],
      );
      await tx.query(
        'UPDATE board_guest_sessions SET "revokedAt"=COALESCE("revokedAt",clock_timestamp()) WHERE "ownerId"=$1 AND "boardId"=$2',
        [owner, id],
      );
    });
  }

  private async readLinks(owner: string, id: string, tx: SQL): Promise<BoardLinks> {
    // Sequential queries keep this usable inside both pg and PGlite transactions.
    const lessons = await tx.query<BoardLinks['lessons'][number]>(
      'SELECT "lessonId","snapshotId","createdAt" FROM board_lessons WHERE "ownerId"=$1 AND "boardId"=$2 ORDER BY "lessonId"',
      [owner, id],
    );
    const students = await tx.query<BoardLinks['students'][number]>(
      'SELECT "studentId","createdAt" FROM board_students WHERE "ownerId"=$1 AND "boardId"=$2 ORDER BY "studentId"',
      [owner, id],
    );
    return { lessons, students };
  }

  async links(owner: string, id: string): Promise<BoardLinks> {
    return this.db.transaction(async (tx) => {
      await this.owned(owner, id, tx, true);
      return this.readLinks(owner, id, tx);
    });
  }

  async link(owner: string, id: string, input: BoardLinkInput): Promise<BoardLinks> {
    const data = boardLinkInput.parse(input);
    return this.db.transaction(async (tx) => {
      await this.owned(owner, id, tx, true);
      if (data.studentId)
        assertFound(
          (
            await tx.query('SELECT id FROM students WHERE "ownerId"=$1 AND id=$2 FOR KEY SHARE', [
              owner,
              data.studentId,
            ])
          )[0],
        );
      if (data.lessonId)
        assertFound(
          (
            await tx.query('SELECT id FROM lessons WHERE "ownerId"=$1 AND id=$2 FOR KEY SHARE', [
              owner,
              data.lessonId,
            ])
          )[0],
        );
      if (data.studentId)
        await tx.query(
          'INSERT INTO board_students ("boardId","ownerId","studentId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [id, owner, data.studentId],
        );
      if (data.lessonId)
        await tx.query(
          `INSERT INTO board_lessons ("boardId","ownerId","lessonId","snapshotId") VALUES ($1,$2,$3,$4)
         ON CONFLICT ("boardId","lessonId") DO UPDATE SET "snapshotId"=CASE WHEN $5 THEN EXCLUDED."snapshotId" ELSE board_lessons."snapshotId" END`,
          [id, owner, data.lessonId, data.snapshotId ?? null, data.snapshotId !== undefined],
        );
      return this.readLinks(owner, id, tx);
    });
  }

  async unlink(owner: string, id: string, input: BoardLinkInput): Promise<BoardLinks> {
    const data = boardLinkInput.parse(input);
    return this.db.transaction(async (tx) => {
      await this.owned(owner, id, tx, true);
      if (data.studentId)
        await tx.query(
          'DELETE FROM board_students WHERE "ownerId"=$1 AND "boardId"=$2 AND "studentId"=$3',
          [owner, id, data.studentId],
        );
      if (data.lessonId)
        await tx.query(
          'DELETE FROM board_lessons WHERE "ownerId"=$1 AND "boardId"=$2 AND "lessonId"=$3',
          [owner, id, data.lessonId],
        );
      return this.readLinks(owner, id, tx);
    });
  }

  async createInvite(
    owner: string,
    id: string,
    input: BoardInviteInput,
  ): Promise<{ invite: BoardInvitation; token: string }> {
    const data = boardInviteInput.parse(input);
    return this.db.transaction(async (tx) => {
      const board = await this.owned(owner, id, tx, true);
      if (board.state !== 'ACTIVE')
        throw new AppError(409, 'Доска ещё создаётся', 'BOARD_NOT_ACTIVE');
      const token = randomBytes(32).toString('hex');
      const invite = assertFound(
        (
          await tx.query<BoardInvitation>(
            `INSERT INTO board_invitations (id,"ownerId","boardId",role,"tokenDigest","expiresAt","maxUses")
         VALUES ($1,$2,$3,$4,$5,clock_timestamp()+$6*interval '1 minute',$7) RETURNING ${inviteColumns}`,
            [randomUUID(), owner, id, data.role, digest(token), data.ttlMinutes, data.maxUses],
          )
        )[0],
      );
      return { invite, token };
    });
  }

  async listInvites(owner: string, id: string): Promise<BoardInvitation[]> {
    return this.db.transaction(async (tx) => {
      await this.owned(owner, id, tx, true);
      return tx.query<BoardInvitation>(
        `SELECT ${inviteColumns} FROM board_invitations WHERE "ownerId"=$1 AND "boardId"=$2 ORDER BY "createdAt" DESC,id`,
        [owner, id],
      );
    });
  }

  async revokeInvite(owner: string, id: string, invitationId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.owned(owner, id, tx, true);
      assertFound(
        (
          await tx.query(
            'UPDATE board_invitations SET "revokedAt"=COALESCE("revokedAt",clock_timestamp()) WHERE "ownerId"=$1 AND "boardId"=$2 AND id=$3 RETURNING id',
            [owner, id, invitationId],
          )
        )[0],
      );
      await tx.query(
        'UPDATE board_guest_sessions SET "revokedAt"=COALESCE("revokedAt",clock_timestamp()) WHERE "ownerId"=$1 AND "boardId"=$2 AND "invitationId"=$3',
        [owner, id, invitationId],
      );
    });
  }

  async redeem(id: string, invitationToken: string): Promise<BoardRedemption> {
    const tokenDigest = digest(invitationToken);
    return this.db.transaction(async (tx) => {
      // This is also the ordering lock for revoke/remove, always acquired first.
      const board = assertFound(
        (
          await tx.query<Board>(
            `SELECT ${boardColumns} FROM boards WHERE id=$1 AND state='ACTIVE' FOR UPDATE`,
            [id],
          )
        )[0],
      );
      const invitation = assertFound(
        (
          await tx.query<BoardInvitation>(
            `UPDATE board_invitations SET uses=uses+1 WHERE "ownerId"=$1 AND "boardId"=$2 AND "tokenDigest"=$3
         AND "revokedAt" IS NULL AND "expiresAt">clock_timestamp() AND uses<"maxUses" RETURNING ${inviteColumns}`,
            [board.ownerId, id, tokenDigest],
          )
        )[0],
      );
      const token = randomBytes(32).toString('hex');
      const session = assertFound(
        (
          await tx.query<BoardGuestSession>(
            `INSERT INTO board_guest_sessions (id,"ownerId","boardId","invitationId",role,"tokenDigest","expiresAt")
         VALUES ($1,$2,$3,$4,$5,$6,LEAST($7::timestamptz,clock_timestamp()+interval '12 hours'))
         RETURNING id,"boardId",role,"expiresAt"`,
            [
              randomUUID(),
              board.ownerId,
              id,
              invitation.id,
              invitation.role,
              digest(token),
              invitation.expiresAt,
            ],
          )
        )[0],
      );
      return { token, session, board: { id: board.id, title: board.title } };
    });
  }

  async authorizeGuest(id: string, sessionToken: string): Promise<BoardGuestSession> {
    const tokenDigest = digest(sessionToken);
    return this.db.transaction(async (tx) => {
      assertFound(
        (
          await tx.query("SELECT id FROM boards WHERE id=$1 AND state='ACTIVE' FOR UPDATE", [id])
        )[0],
      );
      return assertFound(
        (
          await tx.query<BoardGuestSession>(
            `SELECT ${guestColumns} FROM board_guest_sessions s
         JOIN board_invitations i ON i.id=s."invitationId" AND i."boardId"=s."boardId" AND i."ownerId"=s."ownerId" AND i.role=s.role
         WHERE s."boardId"=$1 AND s."tokenDigest"=$2 AND s."revokedAt" IS NULL AND s."expiresAt">clock_timestamp()
         AND i."revokedAt" IS NULL AND i."expiresAt">clock_timestamp()`,
            [id, tokenDigest],
          )
        )[0],
      );
    });
  }
}

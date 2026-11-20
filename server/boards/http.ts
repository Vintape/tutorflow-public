import type { Express, Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { fromNodeHeaders } from 'better-auth/node';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import {
  boardCreateInput,
  boardInviteInput,
  boardLinkInput,
  boardRenameInput,
} from '../../shared/boards.js';
import { canonicalBoardDocument } from '../../shared/board-fingerprint.js';
import type { Config } from '../config.js';
import type { Database } from '../db.js';
import type { createAuth } from '../auth.js';
import { AppError, assertFound } from '../errors.js';
import { BoardService } from './service.js';
import { BoardRuntime } from './runtime.js';

export interface BoardContext {
  db: Database;
  config: Config;
  auth: ReturnType<typeof createAuth>;
  boards: BoardService;
  runtime?: BoardRuntime;
}
export interface BoardPrincipal {
  kind: 'owner' | 'guest';
  principalId: string;
  boardId: string;
  title: string;
  role: 'owner' | 'editor' | 'viewer';
  expiresAt?: string;
}
export const BOARD_COOKIE = 'tutorflow_board_session';
function notFound(): never {
  throw new AppError(404, 'Запись не найдена', 'NOT_FOUND');
}
function boardId(req: Request): string {
  return z.uuid().parse(req.params.id);
}
function owner(res: Response): string {
  return (res.locals.user as { id: string }).id;
}
export function requireBoardRuntime(context: BoardContext): BoardRuntime {
  if (
    !context.runtime ||
    context.config.boardsEnabled === false ||
    (context.config.production && !context.config.boardLicenseKey)
  )
    throw new AppError(503, 'Доски пока недоступны', 'BOARDS_UNAVAILABLE');
  return context.runtime;
}
export function requireBoardOrigin(context: BoardContext, req: IncomingMessage): void {
  if (req.headers.origin !== context.config.appUrl)
    throw new AppError(403, 'Недопустимый источник запроса', 'ORIGIN');
}
function tokenFromCookie(req: IncomingMessage): string | undefined {
  const values = (req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${BOARD_COOKIE}=`));
  if (values.length !== 1) return undefined;
  const value = values[0].slice(BOARD_COOKIE.length + 1);
  return /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}
/** Re-read current owner/guest authorization; caller owns the ordered runtime boundary. */
export async function authorizeIncoming(
  context: BoardContext,
  req: IncomingMessage,
  id: string,
): Promise<BoardPrincipal> {
  z.uuid().parse(id);
  requireBoardRuntime(context);
  const session = await context.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (session) {
    try {
      const board = await context.boards.get(session.user.id, id);
      if (board.state !== 'ACTIVE') notFound();
      return {
        kind: 'owner',
        principalId: session.user.id,
        boardId: id,
        title: board.title,
        role: 'owner',
      };
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 404) throw error;
    }
  }
  const token = tokenFromCookie(req);
  if (!token) notFound();
  const guest = await context.boards.authorizeGuest(id, token);
  const [board] = await context.db.query<{ title: string }>(
    "SELECT title FROM boards WHERE id=$1 AND state='ACTIVE'",
    [id],
  );
  return {
    kind: 'guest',
    principalId: guest.id,
    boardId: id,
    title: assertFound(board).title,
    role: guest.role,
    expiresAt: guest.expiresAt,
  };
}
function publicMetadata(access: BoardPrincipal, context: BoardContext) {
  return {
    boardId: access.boardId,
    title: access.title,
    role: access.role,
    expiresAt: access.expiresAt,
    licenseKey: context.config.boardLicenseKey,
  };
}
function endpointHeaders(context: BoardContext) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
    try {
      requireBoardRuntime(context);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) requireBoardOrigin(context, req);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function mountBoardAccess(app: Express, context: BoardContext): void {
  const path = '/api/board-access/:id';
  // Two people can join with six retries each; reconnects reuse their scoped cookie.
  // Six full exports allow manual recovery while bounding an 8 MiB board to 48 MiB/min/IP.
  // Per-mount stores and the library's default IPv4/IPv6 handling prevent cross-app counters
  // and prevent rotating board IDs from bypassing a client's overall HTTP budget.
  const limiter = (limit: number, identifier: string) =>
    rateLimit({
      windowMs: 60_000,
      limit,
      identifier,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: {
        error: 'Слишком много запросов к доске. Повторите через минуту.',
        code: 'RATE_LIMIT',
      },
    });
  const scopedLimiter = limiter(120, 'board-http');
  const redemptionLimiter = limiter(12, 'board-redeem');
  const exportLimiter = limiter(6, 'board-export');
  app.use('/api/board-access', endpointHeaders(context), scopedLimiter);
  app.post(`${path}/redeem`, redemptionLimiter, async (req, res) => {
    const id = boardId(req);
    const input = z
      .object({ token: z.string().regex(/^[0-9a-f]{64}$/) })
      .strict()
      .parse(req.body);
    // Do not let a room/file existence error reveal whether a guessed ID is registered.
    assertFound(
      (await context.db.query("SELECT id FROM boards WHERE id=$1 AND state='ACTIVE'", [id]))[0],
    );
    const result = await requireBoardRuntime(context).run(id, () =>
      context.boards.redeem(id, input.token),
    );
    res.cookie(BOARD_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: new URL(context.config.appUrl).protocol === 'https:',
      path: `/api/board-access/${id}`,
      expires: new Date(result.session.expiresAt),
    });
    res.json(
      publicMetadata(
        {
          kind: 'guest',
          principalId: result.session.id,
          boardId: id,
          title: result.board.title,
          role: result.session.role,
          expiresAt: result.session.expiresAt,
        },
        context,
      ),
    );
  });
  app.get(`${path}/session`, async (req, res) => {
    const id = boardId(req);
    if (Object.keys(req.query).length) notFound();
    await authorizeIncoming(context, req, id);
    const access = await requireBoardRuntime(context).run(id, () =>
      authorizeIncoming(context, req, id),
    );
    res.json(publicMetadata(access, context));
  });
  app.get(`${path}/status`, async (req, res) => {
    const id = boardId(req);
    if (Object.keys(req.query).length) notFound();
    await authorizeIncoming(context, req, id);
    const proof = await requireBoardRuntime(context).run(id, async () => {
      await authorizeIncoming(context, req, id);
      const snapshot = requireBoardRuntime(context).snapshot(id).document;
      const fingerprint = createHash('sha256')
        .update(canonicalBoardDocument(snapshot.documents.map((d) => d.state)), 'utf8')
        .digest('hex');
      return { documentClock: snapshot.documentClock ?? snapshot.clock ?? 0, fingerprint };
    });
    res.json(proof);
  });
  app.get(`${path}/export`, exportLimiter, async (req, res) => {
    const id = boardId(req);
    await authorizeIncoming(context, req, id);
    const result = await requireBoardRuntime(context).run(id, async () => {
      await authorizeIncoming(context, req, id);
      return requireBoardRuntime(context).snapshot(id);
    });
    res
      .set('Content-Disposition', `attachment; filename="tutorflow-board-${id}.json"`)
      .json(result);
  });
  app.post(`${path}/code/:shapeId`, async (req, res) => {
    const id = boardId(req);
    const shapeId = z
      .string()
      .regex(/^shape:.{1,200}$/)
      .parse(req.params.shapeId);
    const input = z
      .object({ expectedVersion: z.number().int().min(1).max(1e9), source: z.string().max(65536) })
      .strict()
      .parse(req.body);
    const authorizeEdit = async () => {
      const access = await authorizeIncoming(context, req, id);
      if (access.role === 'viewer')
        throw new AppError(403, 'Доступ только для просмотра', 'READ_ONLY');
    };
    await authorizeEdit();
    res.json(
      await requireBoardRuntime(context).updateCode(
        id,
        shapeId,
        input.expectedVersion,
        input.source,
        authorizeEdit,
      ),
    );
  });
  // Unknown scoped routes never fall through into CRM owner middleware.
  app.use('/api/board-access', (_req, _res, next) =>
    next(new AppError(404, 'Маршрут не найден', 'NOT_FOUND')),
  );
}

export function mountBoardOwners(app: Express, context: BoardContext): void {
  const path = '/api/boards/:id';
  app.use('/api/boards', endpointHeaders(context));
  app.get('/api/boards', async (_req, res) => res.json(await context.boards.list(owner(res))));
  app.get('/api/lessons/:id/boards', async (req, res) => {
    requireBoardRuntime(context);
    res.json(await context.boards.forLesson(owner(res), boardId(req)));
  });
  app.post('/api/boards', async (req, res) => {
    const board = await context.boards.create(owner(res), boardCreateInput.parse(req.body));
    const runtime = requireBoardRuntime(context);
    if (board.state === 'CREATING') runtime.ensure(board.id);
    res
      .status(201)
      .json(await runtime.run(board.id, () => context.boards.activate(owner(res), board.id)));
  });
  app.get(path, async (req, res) => res.json(await context.boards.get(owner(res), boardId(req))));
  app.patch(path, async (req, res) => {
    const id = boardId(req),
      data = boardRenameInput.parse(req.body);
    res.json(await context.boards.rename(owner(res), id, data.title));
  });
  app.delete(path, async (req, res) => {
    const id = boardId(req),
      runtime = requireBoardRuntime(context);
    await runtime.order(id, async () => {
      await context.boards.remove(owner(res), id);
      runtime.purge(id);
    });
    res.json({ ok: true });
  });
  app.get(`${path}/links`, async (req, res) =>
    res.json(await context.boards.links(owner(res), boardId(req))),
  );
  app.post(`${path}/links`, async (req, res) => {
    const id = boardId(req),
      data = boardLinkInput.parse(req.body),
      runtime = requireBoardRuntime(context);
    await context.boards.get(owner(res), id);
    res.json(
      await runtime.run(id, async () => {
        await context.boards.get(owner(res), id);
        if (data.snapshotId) runtime.version(id, data.snapshotId);
        return context.boards.link(owner(res), id, data);
      }),
    );
  });
  app.delete(`${path}/links`, async (req, res) =>
    res.json(await context.boards.unlink(owner(res), boardId(req), boardLinkInput.parse(req.body))),
  );
  app.get(`${path}/export`, async (req, res) => {
    const id = boardId(req),
      runtime = requireBoardRuntime(context);
    await context.boards.get(owner(res), id);
    const result = await runtime.run(id, async () => {
      await context.boards.get(owner(res), id);
      return runtime.snapshot(id);
    });
    res
      .set('Content-Disposition', `attachment; filename="tutorflow-board-${id}.json"`)
      .json(result);
  });
  app.post(`${path}/copy`, async (req, res) => {
    const id = boardId(req),
      runtime = requireBoardRuntime(context);
    const data = z
      .object({
        requestId: z.uuid(),
        title: z.string().trim().min(1).max(200).optional(),
        snapshotId: z.uuid().optional(),
      })
      .strict()
      .parse(req.body);
    await context.boards.get(owner(res), id);
    const source = await runtime.run(id, async () => {
      const board = await context.boards.get(owner(res), id);
      return {
        board,
        document: data.snapshotId
          ? runtime.version(id, data.snapshotId).document
          : runtime.snapshot(id),
      };
    });
    const copy = await context.boards.create(owner(res), {
      requestId: data.requestId,
      title: data.title ?? `${source.board.title.slice(0, 190)} — копия`,
    });
    if (copy.id === id)
      throw new AppError(409, 'Для копии нужен новый идентификатор запроса', 'REQUEST_CONFLICT');
    if (copy.state === 'CREATING') runtime.ensure(copy.id, source.document);
    res
      .status(201)
      .json(await runtime.run(copy.id, () => context.boards.activate(owner(res), copy.id)));
  });
  app.get(`${path}/versions`, async (req, res) => {
    const id = boardId(req),
      runtime = requireBoardRuntime(context);
    await context.boards.get(owner(res), id);
    res.json(
      await runtime.run(id, async () => {
        await context.boards.get(owner(res), id);
        return runtime.versions(id);
      }),
    );
  });
  app.post(`${path}/versions`, async (req, res) => {
    const id = boardId(req),
      runtime = requireBoardRuntime(context),
      data = z
        .object({
          label: z.string().trim().min(1).max(100),
          request: z
            .object({ id: z.uuid(), fingerprint: z.string().regex(/^[0-9a-f]{64}$/) })
            .strict()
            .optional(),
        })
        .strict()
        .parse(req.body);
    await context.boards.get(owner(res), id);
    res.status(201).json(
      await runtime.run(id, async () => {
        await context.boards.get(owner(res), id);
        return runtime.createVersion(id, data.label, data.request);
      }),
    );
  });
  app.get(`${path}/versions/:versionId/export`, async (req, res) => {
    const id = boardId(req),
      versionId = z.uuid().parse(req.params.versionId),
      runtime = requireBoardRuntime(context);
    await context.boards.get(owner(res), id);
    res.json(
      await runtime.run(id, async () => {
        await context.boards.get(owner(res), id);
        return runtime.version(id, versionId).document;
      }),
    );
  });
  app.get(`${path}/invites`, async (req, res) =>
    res.json(await context.boards.listInvites(owner(res), boardId(req))),
  );
  app.post(`${path}/invites`, async (req, res) =>
    res
      .status(201)
      .json(
        await context.boards.createInvite(
          owner(res),
          boardId(req),
          boardInviteInput.parse(req.body),
        ),
      ),
  );
  app.post(`${path}/invites/:inviteId/revoke`, async (req, res) => {
    const id = boardId(req),
      inviteId = z.uuid().parse(req.params.inviteId),
      runtime = requireBoardRuntime(context);
    await runtime.order(id, async () => {
      await context.boards.revokeInvite(owner(res), id, inviteId);
      runtime.closeGuests(id);
    });
    res.json({ ok: true });
  });
}

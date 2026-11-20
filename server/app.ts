import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { DateTime } from 'luxon';
import {
  studentInput,
  lessonInput,
  lessonPatch,
  reportInput,
  reportStyle,
  settingsInput,
} from '../shared/domain.js';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { createAuth } from './auth.js';
import { TutorService } from './service.js';
import { AppError } from './errors.js';
import { OpenAIReportProvider, ReportGenerator, type ReportProvider } from './ai.js';
import { BoardService } from './boards/service.js';
import type { BoardRuntime } from './boards/runtime.js';
import { mountBoardAccess, mountBoardOwners } from './boards/http.js';
import { mountGoogleCalendar } from './google-calendar/http.js';
import type { GoogleCalendarClient } from './google-calendar/oauth.js';

type AuthUser = { id: string; name: string; email: string };
function id(req: Request) {
  return z.string().uuid().parse(req.params.id);
}
function owner(res: Response): string {
  return (res.locals.user as AuthUser).id;
}

export function createApp(
  db: Database,
  config: Config,
  provider?: ReportProvider,
  runtime?: BoardRuntime,
  googleCalendarClient?: GoogleCalendarClient,
) {
  const app = express();
  app.disable('x-powered-by');
  const auth = createAuth(db, config);
  const service = new TutorService(db);
  const boards = new BoardService(db);
  const boardContext = { db, config, auth, boards, runtime };
  const generator = new ReportGenerator(
    service,
    config,
    provider ?? (config.aiKey ? new OpenAIReportProvider(config) : undefined),
  );
  app.use(
    helmet({
      contentSecurityPolicy: config.production
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:'],
              connectSrc: ["'self'"],
              fontSrc: ["'self'"],
              frameAncestors: ["'none'"],
              objectSrc: ["'none'"],
            },
          }
        : false,
    }),
  );
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== config.appUrl) {
      return next(
        new AppError(
          403,
          'Недопустимый источник запроса. Откройте приложение по основному адресу.',
          'ORIGIN',
        ),
      );
    }
    next();
  });
  const authLimiter = rateLimit({
    windowMs: 60_000,
    limit: 80,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Слишком много попыток. Подождите минуту.', code: 'RATE_LIMIT' },
  });
  app.use('/api/auth', authLimiter);
  app.all('/api/auth/{*splat}', toNodeHandler(auth));
  // The canonical code limit is 65,536 characters; UTF-8 and JSON escaping can
  // exceed the CRM form budget. Keep the larger parser scoped to this endpoint.
  app.use('/api/board-access/:id/code/:shapeId', express.json({ limit: '300kb' }));
  app.use('/api', express.json({ limit: '64kb' }));
  mountBoardAccess(app, boardContext);
  app.use('/api', async (req, res, next) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) return next(new AppError(401, 'Войдите в аккаунт', 'UNAUTHORIZED'));
    res.locals.user = session.user;
    res.locals.sessionId = session.session.id;
    next();
  });
  const apiLimiter = rateLimit({
    windowMs: 60_000,
    limit: 240,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (_req, res) => owner(res),
    message: { error: 'Слишком много запросов. Подождите минуту.', code: 'RATE_LIMIT' },
  });
  app.use('/api', apiLimiter);
  mountBoardOwners(app, boardContext);
  const processGoogleCalendar = mountGoogleCalendar(app, db, config, googleCalendarClient);
  app.get('/api/me', async (_req, res) => {
    const user = res.locals.user as AuthUser;
    const settings = await service.settings(user.id);
    const [count] = await db.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM students WHERE "ownerId"=$1 AND "archivedAt" IS NULL',
      [user.id],
    );
    res.json({
      user: { id: user.id, name: user.name, email: user.email },
      settings,
      studentCount: count.count,
      ai: {
        available: generator.available,
        dailyLimit: config.aiDailyLimit,
        usedToday: await generator.used(user.id),
      },
      boards: {
        enabled: Boolean(runtime) && (!config.production || Boolean(config.boardLicenseKey)),
      },
    });
  });
  app.get('/api/students', async (req, res) =>
    res.json(await service.listStudents(owner(res), req.query.archived === 'true')),
  );
  app.post('/api/students', async (req, res) =>
    res.status(201).json(await service.createStudent(owner(res), studentInput.parse(req.body))),
  );
  app.get('/api/students/:id', async (req, res) => {
    const student = await service.student(owner(res), id(req));
    const history = await service.listLessons(owner(res), { studentId: student.id });
    const [next] = await db.query<{ id: string; startsAt: string }>(
      'SELECT id, "startsAt" FROM lessons WHERE "ownerId"=$1 AND "studentId"=$2 AND status=\'PLANNED\' AND "startsAt">=now() ORDER BY "startsAt" LIMIT 1',
      [owner(res), student.id],
    );
    const [summary] = await db.query<{ completed: number; accrued: number; received: number }>(
      `SELECT count(*) FILTER (WHERE l.status='COMPLETED')::integer AS completed,
      COALESCE(sum(l.price) FILTER (WHERE l.status='COMPLETED'),0)::double precision AS accrued, COALESCE(sum(p.amount),0)::double precision AS received
      FROM lessons l LEFT JOIN payments p ON p."lessonId"=l.id AND p."ownerId"=$1 AND p."voidedAt" IS NULL
      WHERE l."ownerId"=$1 AND l."studentId"=$2`,
      [owner(res), student.id],
    );
    res.json({ student, ...history, next: next ?? null, summary });
  });
  app.put('/api/students/:id', async (req, res) =>
    res.json(await service.updateStudent(owner(res), id(req), studentInput.parse(req.body))),
  );
  app.post('/api/students/:id/archive', async (req, res) => {
    const data = z.object({ archived: z.boolean() }).strict().parse(req.body);
    res.json(await service.archiveStudent(owner(res), id(req), data.archived));
  });
  app.get('/api/lessons', async (req, res) => {
    const query = z
      .object({
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
        studentId: z.string().uuid().optional(),
        offset: z.coerce.number().int().min(0).max(100000).optional(),
      })
      .strict()
      .parse(req.query);
    if (!query.studentId && (!query.from || !query.to))
      throw new AppError(422, 'Укажите диапазон дат');
    if (
      query.from &&
      query.to &&
      (Date.parse(query.to) <= Date.parse(query.from) ||
        Date.parse(query.to) - Date.parse(query.from) > 93 * 86400000)
    )
      throw new AppError(422, 'Выберите диапазон до 93 дней');
    res.json(await service.listLessons(owner(res), query));
  });
  app.post('/api/lessons', async (req, res) =>
    res.status(201).json(await service.createLesson(owner(res), lessonInput.parse(req.body))),
  );
  app.get('/api/lessons/:id', async (req, res) =>
    res.json(await service.lessonDetail(owner(res), id(req))),
  );
  app.patch('/api/lessons/:id', async (req, res) =>
    res.json(await service.updateLesson(owner(res), id(req), lessonPatch.parse(req.body))),
  );
  app.put('/api/lessons/:id/report', async (req, res) =>
    res.json(await service.saveReport(owner(res), id(req), reportInput.parse(req.body))),
  );
  app.post('/api/lessons/:id/report/copy', async (req, res) =>
    res.json({ content: await service.copyReport(owner(res), id(req)) }),
  );
  app.post('/api/lessons/:id/report/generate', async (req, res) => {
    const data = z
      .object({
        style: reportStyle.default('standard'),
        consent: z.literal(true),
        version: z.number().int().positive(),
      })
      .strict()
      .parse(req.body);
    // Check ownership before revealing provider availability.
    await service.lesson(owner(res), id(req));
    res.json(await generator.generate(owner(res), id(req), data.style, data.version));
  });
  app.post('/api/lessons/:id/payment', async (req, res) => {
    const data = z
      .object({ paidAt: z.iso.datetime({ offset: true }) })
      .strict()
      .parse(req.body);
    res.json(await service.pay(owner(res), id(req), data.paidAt));
  });
  app.post('/api/payments/:id/reverse', async (req, res) => {
    await service.reversePayment(owner(res), id(req));
    res.json({ ok: true });
  });
  app.get('/api/finance', async (req, res) => {
    const settings = await service.settings(owner(res));
    const month = z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .parse(req.query.month || DateTime.now().setZone(settings.timezone).toFormat('yyyy-MM'));
    res.json(await service.finance(owner(res), month));
  });
  app.get('/api/overview', async (_req, res) => res.json(await service.overview(owner(res))));
  app.put('/api/settings', async (req, res) => {
    const data = settingsInput.parse(req.body);
    await db.transaction(async (tx) => {
      await tx.query('UPDATE "user" SET name=$2, "updatedAt"=now() WHERE id=$1', [
        owner(res),
        data.name,
      ]);
      await tx.query(
        'INSERT INTO settings ("ownerId",timezone,theme) VALUES ($1,$2,$3) ON CONFLICT ("ownerId") DO UPDATE SET timezone=$2,theme=$3',
        [owner(res), data.timezone, data.theme],
      );
    });
    res.json({ ok: true });
  });
  app.get('/api/export', async (_req, res) => {
    const user = res.locals.user as AuthUser;
    // Deliberately excludes auth tables, hashes, tokens and diagnostics.
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      user: { name: user.name, email: user.email },
      settings: await service.settings(user.id),
      students: await db.query('SELECT * FROM students WHERE "ownerId"=$1', [user.id]),
      lessons: await db.query('SELECT * FROM lessons WHERE "ownerId"=$1', [user.id]),
      reports: await db.query('SELECT * FROM reports WHERE "ownerId"=$1', [user.id]),
      payments: await db.query('SELECT * FROM payments WHERE "ownerId"=$1', [user.id]),
    };
    res.set('Content-Disposition', 'attachment; filename="tutorflow-export.json"').json(data);
  });
  app.get('/api/pilot', async (_req, res) => {
    res.json(
      await db.query(
        'SELECT kind, count(*)::integer AS count, min("createdAt") AS first, max("createdAt") AS last FROM pilot_events WHERE "ownerId"=$1 GROUP BY kind',
        [owner(res)],
      ),
    );
  });
  app.use('/api', (_req, _res, next) => next(new AppError(404, 'Маршрут не найден', 'NOT_FOUND')));
  const errorHandler = (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next; // Express recognizes error middleware by its four-argument signature.
    if (error instanceof AppError)
      return res
        .status(error.status)
        .json({ error: error.message, code: error.code, details: error.details });
    if (error instanceof z.ZodError)
      return res.status(422).json({
        error: 'Проверьте заполнение полей формы',
        code: 'VALIDATION',
        details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    if (error instanceof SyntaxError)
      return res.status(400).json({ error: 'Некорректный формат запроса', code: 'BAD_JSON' });
    if (typeof error === 'object' && error && 'status' in error && error.status === 413)
      return res.status(413).json({ error: 'Слишком большой запрос', code: 'TOO_LARGE' });
    console.error('API failure:', error instanceof Error ? error.name : 'UnknownError');
    return res
      .status(500)
      .json({ error: 'Не удалось выполнить действие. Попробуйте ещё раз.', code: 'INTERNAL' });
  };
  app.use(errorHandler);
  return { app, auth, service, generator, boards, boardContext, processGoogleCalendar };
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { DateTime } from 'luxon';
import { createDatabase, migrate, type Database } from '../server/db.js';
import { createApp } from '../server/app.js';
import type { Config } from '../server/config.js';
import { emptyReport, type Lesson, type LessonReport, type Student } from '../shared/domain.js';
import type { GenerationInput, ReportProvider } from '../server/ai.js';

const config: Config = {
  production: false,
  port: 3101,
  appUrl: 'http://localhost:3101',
  secret: 'integration-test-secret-only-not-for-real-use-1234567890',
  dataDir: 'memory://',
  databaseSSL: false,
  aiModel: 'test-provider',
  aiDailyLimit: 20,
};
let db: Database, server: Server, base: string;
let cookieA = '',
  cookieB = '';
let student: Student, lesson: Lesson, report: LessonReport;
const calls: GenerationInput[] = [];
const provider: ReportProvider = {
  async generate(input) {
    calls.push(input);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Explicit test double only. Production has no fallback provider.
    return {
      ...emptyReport,
      topic: input.topic,
      coveredMaterial: input.note,
      homework: input.homework,
    };
  },
};
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = cookieA,
  origin = config.appUrl,
) {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body as T;
}
function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
}
const past = (days: number, hour = 10) =>
  DateTime.now()
    .minus({ days })
    .set({ hour, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!;

beforeAll(async () => {
  db = await createDatabase(config);
  await migrate(db);
  const { app } = createApp(db, config, provider);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  if (db) await db.close();
});

describe('аккаунты и реальные данные', () => {
  it('защищает данные до входа и проверяет Origin', async () => {
    expect((await request('/api/me', 'GET', undefined, '')).status).toBe(401);
    expect((await request('/api/students', 'POST', {}, '', 'https://foreign.example')).status).toBe(
      403,
    );
  });
  it('регистрирует два независимых аккаунта', async () => {
    const a = await request(
      '/api/auth/sign-up/email',
      'POST',
      {
        name: 'Тестовый преподаватель',
        email: 'a@tutorflow.test',
        password: 'SyntheticPassword123!',
      },
      '',
    );
    await json(a);
    cookieA = cookies(a);
    expect(cookieA).toContain('session_token');
    const b = await request(
      '/api/auth/sign-up/email',
      'POST',
      {
        name: 'Другой преподаватель',
        email: 'b@tutorflow.test',
        password: 'SyntheticPassword123!',
      },
      '',
    );
    await json(b);
    cookieB = cookies(b);
  });
  it('создаёт ученика, допускает одинаковые имена и отклоняет некорректные суммы', async () => {
    const input = {
      name: 'Анна Петрова',
      subject: 'Математика',
      level: '8 класс',
      price: 100000,
      duration: 60,
      goal: 'Подготовка',
      notes: '',
    };
    student = await json<Student>(await request('/api/students', 'POST', input), 201);
    await json(await request('/api/students', 'POST', input), 201);
    expect((await request('/api/students', 'POST', { ...input, price: 10.5 })).status).toBe(422);
    expect(
      (await request('/api/students', 'POST', { ...input, ownerId: 'someone-else' })).status,
    ).toBe(422);
    expect((await json<Student[]>(await request('/api/students'))).length).toBe(2);
  });
  it('не отдаёт и не изменяет чужие записи, включая через связи', async () => {
    for (const [path, method, body] of [
      [`/api/students/${student.id}`, 'GET', undefined],
      [`/api/students/${student.id}/archive`, 'POST', { archived: true }],
      ['/api/lessons', 'POST', { studentId: student.id, startsAt: past(2), topic: '' }],
      [`/api/lessons?studentId=${student.id}`, 'GET', undefined],
    ] as const)
      expect((await request(path, method, body, cookieB)).status).toBe(404);
  });
});
describe('жизненный цикл занятия', () => {
  it('создаёт урок с исторической ценой и обнаруживает конфликт', async () => {
    lesson = await json<Lesson>(
      await request('/api/lessons', 'POST', {
        studentId: student.id,
        startsAt: past(2),
        topic: 'Уравнения',
      }),
      201,
    );
    expect(lesson.price).toBe(100000);
    expect(
      (
        await request('/api/lessons', 'POST', {
          studentId: student.id,
          startsAt: past(2),
          topic: '',
        })
      ).status,
    ).toBe(409);
    await json(
      await request(`/api/students/${student.id}`, 'PUT', {
        name: student.name,
        subject: student.subject,
        level: student.level,
        price: 200000,
        duration: 90,
        goal: '',
        notes: '',
      }),
    );
    const detail = await json<{ lesson: Lesson }>(await request(`/api/lessons/${lesson.id}`));
    expect(detail.lesson.price).toBe(100000);
    expect(detail.lesson.duration).toBe(60);
  });
  it('сериализует параллельные проверки конфликтов', async () => {
    const payload = { studentId: student.id, startsAt: past(3), topic: 'Конкурентность' };
    const responses = await Promise.all([
      request('/api/lessons', 'POST', payload),
      request('/api/lessons', 'POST', payload),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  });
  it('проверяет доступ ко всем операциям урока', async () => {
    for (const [path, method, body] of [
      [`/api/lessons/${lesson.id}`, 'GET', undefined],
      [`/api/lessons/${lesson.id}`, 'PATCH', { version: 1, status: 'COMPLETED' }],
      [
        `/api/lessons/${lesson.id}/report`,
        'PUT',
        { content: { ...emptyReport, topic: 'Подмена' }, approve: true, version: 0 },
      ],
      [
        `/api/lessons/${lesson.id}/report/generate`,
        'POST',
        { consent: true, style: 'standard', version: 1 },
      ],
      [`/api/lessons/${lesson.id}/payment`, 'POST', { paidAt: new Date().toISOString() }],
    ] as const)
      expect((await request(path, method, body, cookieB)).status).toBe(404);
  });
  it('переносит и завершает, защищает от потери изменений', async () => {
    lesson = await json<Lesson>(
      await request(`/api/lessons/${lesson.id}`, 'PATCH', {
        version: lesson.version,
        startsAt: past(2, 14),
      }),
    );
    expect(
      (
        await request(`/api/lessons/${lesson.id}`, 'PATCH', {
          version: 1,
          topic: 'Потерянная версия',
        })
      ).status,
    ).toBe(409);
    lesson = await json<Lesson>(
      await request(`/api/lessons/${lesson.id}`, 'PATCH', {
        version: lesson.version,
        status: 'COMPLETED',
        note: 'Анна Петрова решала уравнения. Контакт email@example.com. Задание 12–18.',
        homework: '12–18',
      }),
    );
    expect(lesson.status).toBe('COMPLETED');
    expect(lesson.topic).toBe('Уравнения');
  });
  it('отклоняет завершение будущего занятия и оплату планового', async () => {
    const future = await json<Lesson>(
      await request('/api/lessons', 'POST', {
        studentId: student.id,
        startsAt: DateTime.now().plus({ days: 5 }).toUTC().toISO(),
        topic: '',
      }),
      201,
    );
    expect(
      (
        await request(`/api/lessons/${future.id}`, 'PATCH', {
          status: 'COMPLETED',
          version: future.version,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await request(`/api/lessons/${future.id}/payment`, 'POST', {
          paidAt: new Date().toISOString(),
        })
      ).status,
    ).toBe(409);
  });
});
describe('черновик, проверка и опциональный ИИ', () => {
  it('сохраняет ручной черновик, запрещает копирование до проверки', async () => {
    report = await json<LessonReport>(
      await request(`/api/lessons/${lesson.id}/report`, 'PUT', {
        content: { ...emptyReport, topic: 'Квадратные уравнения' },
        approve: false,
        version: 0,
      }),
    );
    expect(report.status).toBe('DRAFT');
    expect((await request(`/api/lessons/${lesson.id}/report/copy`, 'POST', {})).status).toBe(409);
  });
  it('не теряет отредактированный текст, возвращает к проверке после изменений', async () => {
    report = await json<LessonReport>(
      await request(`/api/lessons/${lesson.id}/report`, 'PUT', {
        content: { ...report.content, strengths: 'Понимает формулы' },
        approve: true,
        version: report.version,
      }),
    );
    expect(report.status).toBe('APPROVED');
    await json(await request(`/api/lessons/${lesson.id}/report/copy`, 'POST', {}));
    report = await json<LessonReport>(
      await request(`/api/lessons/${lesson.id}/report`, 'PUT', {
        content: { ...report.content, strengths: 'Формулы понимает, вычисления требуют практики' },
        approve: false,
        version: report.version,
      }),
    );
    expect(report.status).toBe('DRAFT');
    expect(
      (
        await request(`/api/lessons/${lesson.id}/report`, 'PUT', {
          content: report.content,
          approve: true,
          version: 1,
        })
      ).status,
    ).toBe(409);
  });
  it('объединяет одинаковые генерации и не передаёт имя/контакты', async () => {
    const payload = { consent: true, style: 'standard', version: lesson.version };
    const responses = await Promise.all([
      request(`/api/lessons/${lesson.id}/report/generate`, 'POST', payload),
      request(`/api/lessons/${lesson.id}/report/generate`, 'POST', payload),
    ]);
    for (const response of responses) report = await json<LessonReport>(response);
    expect(calls.length).toBe(1);
    expect(JSON.stringify(calls[0])).not.toMatch(/Анна|Петрова|email@example/);
    expect(report.status).toBe('DRAFT');
    expect(report.source).toBe('AI');
    expect(report.content.homework).toBe('12–18');
  });
  it('изменение заметки сбрасывает подтверждение отчёта', async () => {
    report = await json<LessonReport>(
      await request(`/api/lessons/${lesson.id}/report`, 'PUT', {
        content: report.content,
        approve: true,
        version: report.version,
      }),
    );
    lesson = await json<Lesson>(
      await request(`/api/lessons/${lesson.id}`, 'PATCH', {
        version: lesson.version,
        note: 'Уточнение заметки',
      }),
    );
    const detail = await json<{ report: LessonReport }>(await request(`/api/lessons/${lesson.id}`));
    expect(detail.report.status).toBe('DRAFT');
  });
  it('требует явного согласия и ограничивает длину заметки', async () => {
    expect(
      (
        await request(`/api/lessons/${lesson.id}/report/generate`, 'POST', {
          style: 'standard',
          version: lesson.version,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await request(`/api/lessons/${lesson.id}`, 'PATCH', {
          version: lesson.version,
          note: 'x'.repeat(8001),
        })
      ).status,
    ).toBe(422);
  });
});
describe('финансовая достоверность', () => {
  let paymentId: string;
  it('отделяет начисления от фактического поступления и долга', async () => {
    const month = DateTime.now().setZone('Europe/Moscow').toFormat('yyyy-MM');
    const before = await json<{ debt: number; received: number }>(
      await request(`/api/finance?month=${month}`),
    );
    expect(before.debt).toBe(100000);
    expect(before.received).toBe(0);
    const pay = () =>
      request(`/api/lessons/${lesson.id}/payment`, 'POST', { paidAt: new Date().toISOString() });
    const payments = await Promise.all([pay(), pay(), pay()]);
    const data = await Promise.all(payments.map((r) => json<{ id: string; amount: number }>(r)));
    paymentId = data[0].id;
    expect(new Set(data.map((p) => p.id)).size).toBe(1);
    expect(data[0].amount).toBe(100000);
    const after = await json<{ debt: number; received: number }>(
      await request(`/api/finance?month=${month}`),
    );
    expect(after.debt).toBe(0);
    expect(after.received).toBe(100000);
  });
  it('запрещает менять цену и отменять оплаченный урок', async () => {
    expect(
      (
        await request(`/api/lessons/${lesson.id}`, 'PATCH', {
          version: lesson.version,
          price: 90000,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/api/lessons/${lesson.id}`, 'PATCH', {
          version: lesson.version,
          status: 'CANCELLED',
        })
      ).status,
    ).toBe(409);
    expect((await request(`/api/payments/${paymentId}/reverse`, 'POST', {}, cookieB)).status).toBe(
      404,
    );
  });
  it('исправляет оплату с сохранением истории; отмена не начисляет доход', async () => {
    await json(await request(`/api/payments/${paymentId}/reverse`, 'POST', {}));
    await json(await request(`/api/payments/${paymentId}/reverse`, 'POST', {}));
    const detail = await json<{ payments: { voidedAt: string | null }[] }>(
      await request(`/api/lessons/${lesson.id}`),
    );
    expect(detail.payments).toHaveLength(1);
    expect(detail.payments[0].voidedAt).not.toBeNull();
    lesson = await json<Lesson>(
      await request(`/api/lessons/${lesson.id}`, 'PATCH', {
        version: lesson.version,
        status: 'CANCELLED',
      }),
    );
    const finance = await json<{ debt: number; received: number }>(await request('/api/finance'));
    expect(finance.debt).toBe(0);
    expect(finance.received).toBe(0);
  });
});
describe('архив, экспорт и сессии', () => {
  it('архивирует без удаления истории и возвращает из архива', async () => {
    await json(await request(`/api/students/${student.id}/archive`, 'POST', { archived: true }));
    expect(
      (
        await request('/api/lessons', 'POST', {
          studentId: student.id,
          startsAt: past(6),
          topic: '',
        })
      ).status,
    ).toBe(409);
    expect(
      (await json<Student[]>(await request('/api/students?archived=true'))).some(
        (s) => s.id === student.id,
      ),
    ).toBe(true);
    expect((await request(`/api/lessons/${lesson.id}`)).status).toBe(200);
    await json(await request(`/api/students/${student.id}/archive`, 'POST', { archived: false }));
  });
  it('экспортирует только собственные данные без паролей и сессий', async () => {
    const a = await json<{ students: Student[] }>(await request('/api/export'));
    expect(a.students.some((s) => s.id === student.id)).toBe(true);
    expect(JSON.stringify(a)).not.toMatch(/SyntheticPassword|session_token|accessToken|password/);
    const b = await json<{ students: Student[] }>(
      await request('/api/export', 'GET', undefined, cookieB),
    );
    expect(b.students).toEqual([]);
  });
  it('меняет настройки с валидным часовым поясом', async () => {
    await json(
      await request('/api/settings', 'PUT', {
        name: 'Новое имя',
        timezone: 'Asia/Yekaterinburg',
        theme: 'dark',
      }),
    );
    const me = await json<{ settings: { timezone: string }; user: { name: string } }>(
      await request('/api/me'),
    );
    expect(me.settings.timezone).toBe('Asia/Yekaterinburg');
    expect(me.user.name).toBe('Новое имя');
    expect(
      (await request('/api/settings', 'PUT', { name: 'Имя', timezone: 'Fake/Zone', theme: 'dark' }))
        .status,
    ).toBe(422);
  });
  it('завершает сессию и входит снова с сохранёнными данными', async () => {
    await json(await request('/api/auth/sign-out', 'POST', {}));
    expect((await request('/api/me')).status).toBe(401);
    const login = await request(
      '/api/auth/sign-in/email',
      'POST',
      { email: 'a@tutorflow.test', password: 'SyntheticPassword123!' },
      '',
    );
    await json(login);
    cookieA = cookies(login);
    expect(
      (await json<Student[]>(await request('/api/students'))).some((s) => s.id === student.id),
    ).toBe(true);
  });
});

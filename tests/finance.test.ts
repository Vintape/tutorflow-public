import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, migrate, type Database } from '../server/db.js';
import { TutorService } from '../server/service.js';

let db: Database, service: TutorService;
const owner = 'synthetic-finance-owner';
let studentId: string;
beforeAll(async () => {
  db = await createDatabase({ dataDir: 'memory://' });
  await migrate(db);
  service = new TutorService(db);
  await db.query('INSERT INTO "user" (id,name,email) VALUES ($1,$2,$3)', [
    owner,
    'Тест',
    'finance@tutorflow.test',
  ]);
  studentId = (
    await service.createStudent(owner, {
      name: 'Вымышленный',
      subject: 'Математика',
      level: '',
      price: 100000000,
      duration: 60,
      goal: '',
      notes: '',
    })
  ).id;
});
afterAll(async () => {
  await db.close();
});
it('не переполняет 32-битное целое при суммировании корректных индивидуальных цен', async () => {
  await db.query(
    `INSERT INTO lessons (id,"ownerId","studentId","startsAt",price,duration,status)
    SELECT 'finance-bulk-' || n, $1, $2, '2020-11-10T10:00:00Z'::timestamptz + n * interval '2 hours', 100000000,60,'COMPLETED'
    FROM generate_series(1,25) n`,
    [owner, studentId],
  );
  const finance = await service.finance(owner, '2020-11');
  expect(finance.accrued).toBe(2500000000);
  expect(finance.debt).toBe(2500000000);
  expect((await service.listStudents(owner))[0].debt).toBe(2500000000);
});
it('разделяет месяц проведения и месяц фактического поступления в часовом поясе репетитора', async () => {
  const lesson = await service.createLesson(owner, {
    studentId,
    startsAt: '2020-10-31T21:30:00.000Z',
    price: 12345,
    duration: 60,
    topic: 'Урок 1 ноября в Москве',
    allowConflict: false,
  });
  const done = await service.updateLesson(owner, lesson.id, {
    status: 'COMPLETED',
    version: lesson.version,
  });
  await service.pay(owner, done.id, '2020-11-30T21:30:00.000Z'); // December 1, Moscow.
  const november = await service.finance(owner, '2020-11');
  const december = await service.finance(owner, '2020-12');
  expect(november.accrued).toBe(2500012345);
  expect(november.received).toBe(0);
  expect(december.accrued).toBe(0);
  expect(december.received).toBe(12345);
  expect(december.debt).toBe(2500000000);
});

import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { DateTime } from 'luxon';
import { loadConfig } from '../server/config.js';
import { createDatabase, migrate } from '../server/db.js';
import { createAuth } from '../server/auth.js';
import { TutorService } from '../server/service.js';
import { emptyReport } from '../shared/domain.js';

const config = loadConfig();
if (config.production || !process.argv.includes('--demo')) {
  console.error(
    'Seed разрешён только явно в development: pnpm db:seed --demo. Остановите приложение перед запуском.',
  );
  process.exit(1);
}
const db = await createDatabase(config);
try {
  await migrate(db);
  const email = 'demo@tutorflow.local';
  if ((await db.query('SELECT id FROM "user" WHERE email=$1', [email])).length) {
    console.log(
      'Отдельный демонстрационный аккаунт уже существует. Данные не изменены. Доступ: .data/demo-login.txt',
    );
  } else {
    const password = randomBytes(18).toString('base64url');
    const { user } = await createAuth(db, config).api.signUpEmail({
      body: { name: 'Александра · демо', email, password },
    });
    const service = new TutorService(db);
    const pupils = [
      {
        name: 'Саша Волкова',
        subject: 'Математика',
        level: '8 класс',
        price: 150000,
        goal: 'Уверенно решать задачи по алгебре',
      },
      {
        name: 'Миша Ковалёв',
        subject: 'Математика',
        level: '9 класс',
        price: 180000,
        goal: 'Подготовка к ОГЭ',
      },
      {
        name: 'Полина Орлова',
        subject: 'Физика',
        level: '10 класс',
        price: 200000,
        goal: 'Разобраться в механике',
      },
    ];
    const students = [];
    for (const pupil of pupils)
      students.push(
        await service.createStudent(user.id, {
          ...pupil,
          duration: 60,
          notes: 'Вымышленные данные для знакомства с приложением.',
        }),
      );
    const now = DateTime.now().setZone('Europe/Moscow');
    for (let index = 0; index < students.length; index++) {
      const student = students[index];
      let past = await service.createLesson(user.id, {
        studentId: student.id,
        startsAt: now
          .minus({ days: 1 })
          .set({ hour: 13 + index * 2, minute: 0 })
          .toUTC()
          .toISO()!,
        topic: ['Квадратные уравнения', 'Задачи с процентами', 'Законы Ньютона'][index],
        allowConflict: false,
      });
      past = await service.updateLesson(user.id, past.id, {
        version: past.version,
        status: 'COMPLETED',
        note: [
          'Решали уравнения. Формулы понимает, ошибки при вычислении дискриминанта. Задал 12–18. Следующий урок — закрепление.',
          'Решали задачи с процентами. Условие понимает, затрудняется составить уравнение.',
          'Разобрали второй закон Ньютона и решили три задачи.',
        ][index],
        homework: index === 0 ? 'Задачи 12–18' : '',
      });
      if (index === 0)
        await service.saveReport(user.id, past.id, {
          content: {
            ...emptyReport,
            topic: past.topic,
            coveredMaterial: 'Решение квадратных уравнений.',
            strengths: 'Понимает формулы.',
            difficulties: 'Точность вычисления дискриминанта.',
            homework: 'Задачи 12–18',
            nextSteps: 'Закрепление.',
          },
          approve: true,
          version: 0,
        });
      if (index !== 1) await service.pay(user.id, past.id, now.minus({ days: 1 }).toUTC().toISO()!);
      const upcoming = now
        .plus({ days: index === 2 ? 1 : 0 })
        .set({ hour: 15 + index * 2, minute: 0 });
      await service.createLesson(user.id, {
        studentId: student.id,
        startsAt: upcoming.toUTC().toISO()!,
        topic: ['Практика: уравнения', 'Подготовка к ОГЭ', 'Силы и движение'][index],
        allowConflict: false,
      });
    }
    await writeFile(
      '.data/demo-login.txt',
      `Только вымышленные демонстрационные данные.\nАдрес: ${config.appUrl}\nПочта: ${email}\nПароль: ${password}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    console.log(
      'Создан отдельный демонстрационный аккаунт. Все имена и учебные записи вымышлены. Доступ записан в .data/demo-login.txt (не входит в Git).',
    );
  }
} finally {
  await db.close();
}

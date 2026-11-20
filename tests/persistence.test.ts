import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, migrate } from '../server/db.js';
import { createAuth } from '../server/auth.js';
import { TutorService } from '../server/service.js';
import type { Config } from '../server/config.js';

it('сохраняет аккаунт, ученика, занятие и оплату при полном переоткрытии файловой базы', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tutorflow-persistence-'));
  const config: Config = {
    production: false,
    port: 3104,
    appUrl: 'http://localhost:3104',
    secret: 'synthetic-persistence-test-secret-long-enough',
    dataDir: join(root, 'postgres'),
    databaseSSL: false,
    aiModel: 'not-used',
    aiDailyLimit: 20,
  };
  let db = await createDatabase(config);
  try {
    await migrate(db);
    await expect(createDatabase(config)).rejects.toMatchObject({ code: 'ELOCKED' });
    const auth = createAuth(db, config);
    const signup = await auth.api.signUpEmail({
      body: {
        name: 'Тестовый аккаунт',
        email: 'persist@tutorflow.test',
        password: 'OnlySyntheticPersistence123!',
      },
    });
    const service = new TutorService(db);
    const student = await service.createStudent(signup.user.id, {
      name: 'Синтетический ученик',
      subject: 'Физика',
      level: '',
      price: 150000,
      duration: 60,
      goal: '',
      notes: '',
    });
    let lesson = await service.createLesson(signup.user.id, {
      studentId: student.id,
      startsAt: new Date(Date.now() - 86400000).toISOString(),
      topic: 'Кинематика',
      allowConflict: false,
    });
    lesson = await service.updateLesson(signup.user.id, lesson.id, {
      version: lesson.version,
      status: 'COMPLETED',
      note: 'Сохранённая заметка',
    });
    await service.pay(signup.user.id, lesson.id, new Date().toISOString());
    await db.close();
    db = await createDatabase(config);
    await migrate(db);
    const login = await createAuth(db, config).api.signInEmail({
      body: { email: 'persist@tutorflow.test', password: 'OnlySyntheticPersistence123!' },
    });
    expect(login.user.id).toBe(signup.user.id);
    const reopened = await new TutorService(db).lessonDetail(login.user.id, lesson.id);
    expect(reopened.lesson.note).toBe('Сохранённая заметка');
    expect(reopened.lesson.price).toBe(150000);
    expect(reopened.payments).toHaveLength(1);
    expect((await new TutorService(db).listStudents(login.user.id))[0].name).toBe(
      'Синтетический ученик',
    );
  } finally {
    await db.close();
    await rm(root, { recursive: true });
  }
});

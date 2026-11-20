import { test, expect } from '@playwright/test';
import { DateTime } from 'luxon';
import { mkdir } from 'node:fs/promises';

test('репетитор проходит основной сценарий, данные сохраняются, вёрстка адаптивна', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const email = `pilot-${Date.now()}@tutorflow.test`;
  const password = 'OnlySyntheticTestPassword123!';
  await page.goto('/');
  await page.getByRole('button', { name: 'Регистрация', exact: true }).click();
  await page.getByLabel('Как к вам обращаться').fill('Тестовый репетитор');
  await page.getByLabel('Электронная почта', { exact: true }).fill(email);
  await page.getByLabel('Пароль', { exact: false }).fill(password);
  await page.getByRole('button', { name: 'Создать пространство' }).click();
  await expect(
    page.getByRole('heading', { name: 'Ваше спокойное рабочее пространство.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Добавить первого ученика', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Имя или псевдоним').fill('Саша Тестовый');
  await dialog.getByLabel('Предмет', { exact: true }).fill('Математика');
  await dialog.getByLabel('Класс или уровень').fill('8 класс');
  await dialog.getByLabel('Стоимость урока, ₽').fill('1250,50');
  await dialog.getByLabel('Цель обучения').fill('Разобраться в алгебре');
  await dialog.getByRole('button', { name: 'Добавить ученика', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Ученики' }).click();
  await page
    .getByRole('link')
    .filter({ has: page.getByRole('heading', { name: 'Саша Тестовый', exact: true }) })
    .click();
  const studentPath = new URL(page.url()).pathname;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Саша Тестовый', exact: true })).toBeVisible();
  await page
    .locator('.student-profile-heading')
    .getByRole('button', { name: 'Запланировать урок' })
    .click();
  const yesterday = DateTime.now().setZone('Europe/Moscow').minus({ days: 1 });
  await dialog.getByLabel('Дата и время').fill(yesterday.toFormat("yyyy-MM-dd'T'16:00"));
  await dialog.getByLabel('Тема').fill('Квадратные уравнения');
  await dialog.getByRole('button', { name: 'Запланировать', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Расписание' }).click();
  if (!yesterday.hasSame(DateTime.now().setZone('Europe/Moscow'), 'week'))
    await page.getByRole('button', { name: 'Предыдущая неделя', exact: true }).click();
  await page.locator('.calendar-lesson').filter({ hasText: 'Саша Тестовый' }).click();
  const lessonPath = new URL(page.url()).pathname;
  await page
    .getByLabel('Заметка преподавателя', { exact: true })
    .fill(
      'Решали квадратные уравнения. Формулы понимает, ошибается при вычислении дискриминанта. Следующий урок — закрепление.',
    );
  await page.getByLabel('Домашнее задание · необязательно', { exact: true }).fill('Номера 12–18');
  await page.getByRole('button', { name: 'Завершить урок', exact: true }).click();
  await expect(page.getByText('Ручной отчёт доступен. ИИ пока не подключён.')).toBeVisible();
  await page
    .getByLabel('Что изучили', { exact: true })
    .fill('Решение квадратных уравнений с помощью дискриминанта.');
  await page.getByLabel('Что получилось', { exact: true }).fill('Понимает формулы.');
  await page
    .getByLabel('Над чем поработаем', { exact: true })
    .fill('Точность вычисления дискриминанта.');
  await page.getByLabel('План следующего занятия', { exact: true }).fill('Закрепление материала.');
  await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
  await expect(page.getByText('Черновик сохранён', { exact: true })).toBeVisible();
  await page
    .getByLabel('Что получилось', { exact: true })
    .fill('Понимает основные формулы и применяет их с подсказкой.');
  await page.getByRole('button', { name: 'Подтвердить отчёт', exact: true }).click();
  await page.getByRole('button', { name: 'Скопировать для родителя' }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('с подсказкой');
  await page.reload();
  await expect(page.getByLabel('Что получилось', { exact: true })).toHaveValue(
    'Понимает основные формулы и применяет их с подсказкой.',
  );
  await page.getByRole('button', { name: 'Отметить оплату', exact: true }).click();
  await dialog.getByRole('button', { name: 'Подтвердить оплату', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.payment-panel .badge')).toContainText('Оплачено');
  // A second real lesson, completed and unpaid, verifies that debt is distinct.
  const busyEndpoint = '**/api/integrations/google-calendar/busy?*';
  await page.route(busyEndpoint, (route) =>
    route.fulfill({
      json: {
        status: 'ready',
        intervals: [
          {
            start: yesterday.set({ hour: 13 }).toUTC().toISO(),
            end: yesterday.set({ hour: 14 }).toUTC().toISO(),
          },
        ],
      },
    }),
  );
  await page.goto(studentPath);
  await page
    .locator('.student-profile-heading')
    .getByRole('button', { name: 'Запланировать урок' })
    .click();
  await dialog.getByLabel('Дата и время').fill(yesterday.toFormat("yyyy-MM-dd'T'13:00"));
  await dialog.getByLabel('Стоимость урока, ₽').fill('2000');
  await dialog.getByLabel('Тема').fill('Геометрия');
  await expect(dialog.getByText('В это время вы заняты по Google Календарю')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Запланировать', exact: true })).toBeDisabled();
  await dialog.getByLabel('Сохранить занятие на это время').check();
  await dialog.getByRole('button', { name: 'Запланировать', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.unroute(busyEndpoint);
  await page.locator('.lesson-row').filter({ hasText: 'Геометрия' }).click();
  await page.getByRole('button', { name: 'Завершить урок', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Отметить оплату', exact: true })).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Финансы' }).click();
  await expect(
    page
      .locator('.metric')
      .filter({ has: page.locator('span', { hasText: /^Получено$/ }) })
      .locator('strong'),
  ).toContainText(/1\s*250,50/);
  await expect(
    page
      .locator('.metric')
      .filter({ has: page.locator('span', { hasText: /^Не оплачено$/ }) })
      .locator('strong'),
  ).toContainText(/2\s*000/);
  // Screenshots and overflow checks use synthetic data, never a real account.
  await mkdir('.data/qa', { recursive: true });
  const paths = [
    { path: '/', name: 'dashboard' },
    { path: '/students', name: 'students' },
    { path: studentPath, name: 'student' },
    { path: '/schedule', name: 'schedule' },
    { path: lessonPath, name: 'report' },
    { path: '/finance', name: 'finance' },
    { path: '/settings', name: 'settings' },
  ];
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
    for (const item of paths) {
      await page.goto(item.path);
      await expect(page.locator('.skeletons')).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `overflow on ${item.name} at ${width}`,
      ).toBe(true);
      await page.screenshot({ path: `.data/qa/${item.name}-${width}.png`, fullPage: true });
    }
  }
  await page.getByLabel('Тёмное', { exact: true }).check();
  await page.getByRole('button', { name: 'Сохранить настройки' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.goto('/');
  await page.screenshot({ path: '.data/qa/dashboard-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'Выйти из аккаунта', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Войти в TutorFlow' })).toBeVisible();
  await page.getByLabel('Электронная почта', { exact: true }).fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти в TutorFlow' }).click();
  await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeVisible();
  await page.goto(studentPath);
  await expect(page.getByRole('heading', { name: 'Саша Тестовый', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

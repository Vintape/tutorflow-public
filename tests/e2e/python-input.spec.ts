import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('Python сохраняет ввод и фокус при загрузке CodeMirror', async ({
  page,
  context,
  baseURL,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const headers = { Origin: baseURL! };
  const signup = await context.request.post('/api/auth/sign-up/email', {
    headers,
    data: {
      name: 'Синтетический преподаватель Python',
      email: `python-${randomUUID()}@tutorflow.test`,
      password: 'OnlySyntheticPythonTest123!',
    },
  });
  expect(signup.ok()).toBe(true);
  const created = await context.request.post('/api/boards', {
    headers,
    data: { title: 'Синтетический ввод Python', requestId: randomUUID() },
  });
  expect(created.ok()).toBe(true);
  const board = (await created.json()) as { id: string };
  await page.goto(`/boards/${board.id}`);
  await expect(page.locator('.tlui-layout')).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('button', { name: 'Python', exact: true })).toBeEnabled();

  // Hold actual lazy module requests: the user begins editing before the
  // enhancement finishes loading, independent of machine/network speed.
  let releaseModules!: () => void;
  let requestedModule!: () => void;
  const modulesHeld = new Promise<void>((resolve) => (requestedModule = resolve));
  const modulesReleased = new Promise<void>((resolve) => (releaseModules = resolve));
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() === 'script') {
      requestedModule();
      await modulesReleased;
    }
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: 'Python', exact: true }).click();
    await modulesHeld;
    const fallback = page.locator('textarea[aria-label="Исходный код Python"]');
    await fallback.fill('print("');
    const input = await context.newCDPSession(page);
    await input.send('Input.imeSetComposition', {
      text: 'сох',
      selectionStart: 3,
      selectionEnd: 3,
    });
    await expect(fallback).toHaveValue('print("сох');
    await expect(fallback).toBeFocused();
    releaseModules();
    await expect(page.locator('.board-codemirror .cm-editor')).toHaveCount(1);
    // Module completion must not detach the active input between keystrokes
    // (or between Playwright fill's focus and browser input events).
    await expect(fallback).toBeFocused();
    await input.send('Input.insertText', { text: 'сохранено' });
    await input.detach();
    await page.keyboard.insertText('")');
    await expect(fallback).toHaveValue('print("сохранено")');
    await page.screenshot({ path: info.outputPath('python-composition-preserved.png') });
    const content = page.locator('.board-codemirror .cm-content');
    const editorNode = await content.elementHandle();
    let releaseSave!: () => void;
    const saving = new Promise<void>((resolve) => (releaseSave = resolve));
    await page.route('**/api/board-access/*/code/*', async (route) => {
      await saving;
      await route.continue();
    });
    const savedCode = page.waitForResponse(
      (response) =>
        response.url().includes('/code/') && response.request().method() === 'POST',
    );
    try {
      await page.getByRole('button', { name: 'Применить код', exact: true }).click();
      await expect(content).toBeVisible();
      await expect(content).toHaveText('print("сохранено")');
      await expect(content).toHaveAttribute('contenteditable', 'false');
      expect(await editorNode!.evaluate((node) => node.isConnected)).toBe(true);
    } finally {
      releaseSave();
    }
    const saveResponse = await savedCode;
    expect(saveResponse.ok()).toBe(true);
    expect(await saveResponse.json()).toMatchObject({ version: 2 });
    await expect(page.getByTestId('board-editor')).toHaveAttribute('data-dirty', 'false');
    await expect(page.getByTestId('board-editor')).toHaveAttribute('data-proof', 'confirmed');
    await expect(content).toHaveAttribute('contenteditable', 'true');
    expect(await editorNode!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(page.locator('.board-python pre')).toHaveText('print("сохранено")');
    await expect(page.getByTestId('board-editor')).toHaveAttribute('data-proof', 'confirmed');
    await page.screenshot({ path: info.outputPath('python-codemirror-saved.png') });
    await page.reload();
    await expect(page.locator('.board-python pre')).toHaveText('print("сохранено")');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    releaseModules();
  }
});

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

interface RecordState {
  id: string;
  type: string;
  props: Record<string, unknown>;
}
interface Document {
  document: { documents: { state: RecordState }[] };
}
interface Recovery {
  format: string;
  board: Document;
  unconfirmedChanges: boolean;
  pythonDrafts: Record<string, { source: string }>;
  mathDrafts: Record<string, { draft: { source: string } }>;
}
let ownerStorage: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;

async function api<T>(
  context: BrowserContext,
  origin: string,
  path: string,
  method = 'GET',
  data?: unknown,
): Promise<T> {
  const response = await context.request.fetch(path, { method, data, headers: { Origin: origin } });
  expect(response.ok(), `${method} ${path}: HTTP ${response.status()}`).toBe(true);
  return (await response.json()) as T;
}
function records(document: Document, type: string) {
  return document.document.documents
    .map((entry) => entry.state)
    .filter((record) => record.type === type);
}
const exported = (owner: BrowserContext, origin: string, id: string) =>
  api<Document>(owner, origin, `/api/boards/${id}/export`);
async function ready(page: Page) {
  await expect(page.locator('.tlui-layout')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.tl-loading')).toHaveCount(0);
}
async function confirmed(page: Page) {
  await expect(page.getByTestId('board-editor')).toHaveAttribute('data-proof', 'confirmed', {
    timeout: 20000,
  });
}
async function shape(owner: BrowserContext, origin: string, id: string, type: string) {
  await expect.poll(async () => records(await exported(owner, origin, id), type).length).toBe(1);
  return records(await exported(owner, origin, id), type)[0];
}
async function setup(
  browser: Browser,
  origin: string,
  contexts: BrowserContext[],
  errors: string[],
) {
  if (!ownerStorage) throw new Error('Synthetic owner session is not ready');
  const owner = await browser.newContext({
    baseURL: origin,
    storageState: ownerStorage,
    viewport: { width: 1440, height: 1000 },
  });
  contexts.push(owner);
  const peer = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  contexts.push(peer);
  const board = await api<{ id: string }>(owner, origin, '/api/boards', 'POST', {
    title: 'Синтетическая совместная проверка',
    requestId: randomUUID(),
  });
  const invite = await api<{ token: string }>(
    owner,
    origin,
    `/api/boards/${board.id}/invites`,
    'POST',
    { role: 'editor', ttlMinutes: 60, maxUses: 1 },
  );
  const ownerPage = await owner.newPage();
  const peerPage = await peer.newPage();
  for (const page of [ownerPage, peerPage])
    page.on('pageerror', (error) => errors.push(error.message));
  await ownerPage.goto(`/boards/${board.id}`);
  await ready(ownerPage);
  await peerPage.goto(`/join/${board.id}#${invite.token}`);
  await peerPage.getByRole('button', { name: 'Присоединиться', exact: true }).click();
  await ready(peerPage);
  await Promise.all([confirmed(ownerPage), confirmed(peerPage)]);
  return { owner, peer, ownerPage, peerPage, id: board.id };
}
async function select(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error('Rendered teaching object is unavailable');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
async function draw(page: Page) {
  await page.getByTestId('tools.draw').click();
  const canvas = await page.getByTestId('canvas').boundingBox();
  if (!canvas) throw new Error('Native canvas is unavailable');
  const x = canvas.x + canvas.width * 0.16;
  const y = canvas.y + canvas.height * 0.3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y + 45, { steps: 10 });
  await page.mouse.move(x + 150, y + 15, { steps: 5 });
  await page.mouse.up();
  await page.getByTestId('tools.select').click();
}
async function recovery(page: Page): Promise<Recovery> {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Экспорт для восстановления', exact: true }).click();
  return JSON.parse(await readFile((await (await download).path())!, 'utf8')) as Recovery;
}

test.beforeAll(async ({ browser }, info) => {
  const origin = String(info.project.use.baseURL);
  const context = await browser.newContext({ baseURL: origin });
  try {
    await api(context, origin, '/api/auth/sign-up/email', 'POST', {
      name: 'Синтетический владелец проверок',
      email: `concurrency-${randomUUID()}@tutorflow.test`,
      password: 'OnlySyntheticConcurrency123!',
    });
    ownerStorage = await context.storageState();
  } finally {
    await context.close();
  }
});
test.afterAll(() => {
  ownerStorage = undefined;
});

test('разные поля одной фигуры сходятся, настоящий Undo/Redo штриха виден независимому клиенту и после reload', async ({
  browser,
  baseURL,
}) => {
  const origin = baseURL!;
  const contexts: BrowserContext[] = [];
  const errors: string[] = [];
  try {
    const { owner, ownerPage, peerPage, id } = await setup(browser, origin, contexts, errors);
    await ownerPage.getByRole('button', { name: 'График', exact: true }).click();
    await ownerPage.getByLabel('y =', { exact: true }).fill('a*x+1');
    await ownerPage.getByRole('button', { name: 'Применить', exact: true }).click();
    await expect
      .poll(async () => (await shape(owner, origin, id, 'math-graph')).props.expression)
      .toBe('a*x+1');
    await expect(
      peerPage.getByRole('img', { name: 'График y = a*x+1, a = 1', exact: true }),
    ).toBeVisible();
    // Finish the initial submitted expression before testing two new, disjoint
    // drafts; an unconfirmed earlier expression is still a real pending edit.
    await Promise.all([confirmed(ownerPage), confirmed(peerPage)]);
    await expect(ownerPage.getByTestId('board-editor')).toHaveAttribute('data-dirty', 'false');
    await expect(peerPage.getByTestId('board-editor')).toHaveAttribute('data-dirty', 'false');
    await select(peerPage, '[data-shape-type="math-graph"]');
    await ownerPage.getByLabel('Параметр a', { exact: true }).fill('2');
    await peerPage.getByLabel('y =', { exact: true }).fill('a*x+2');
    await peerPage.getByRole('button', { name: 'Применить', exact: true }).click();
    await expect(
      ownerPage.getByRole('img', { name: 'График y = a*x+2, a = 1', exact: true }),
    ).toBeVisible();
    await expect(ownerPage.getByLabel('Параметр a', { exact: true })).toHaveValue('2');
    await ownerPage.getByRole('button', { name: 'Применить', exact: true }).click();
    await expect
      .poll(async () => (await shape(owner, origin, id, 'math-graph')).props)
      .toMatchObject({ a: 2, expression: 'a*x+2' });
    await Promise.all([confirmed(ownerPage), confirmed(peerPage)]);
    await expect(ownerPage.getByTestId('board-editor')).toHaveAttribute('data-dirty', 'false');
    await expect(peerPage.getByTestId('board-editor')).toHaveAttribute('data-dirty', 'false');
    await ownerPage.getByLabel('Параметр a', { exact: true }).fill('3');
    await peerPage.getByLabel('y =', { exact: true }).fill('a*x+3');
    await Promise.all([
      ownerPage.getByRole('button', { name: 'Применить', exact: true }).click(),
      peerPage.getByRole('button', { name: 'Применить', exact: true }).click(),
    ]);
    await expect
      .poll(async () => (await shape(owner, origin, id, 'math-graph')).props)
      .toMatchObject({ a: 3, expression: 'a*x+3' });
    await expect(
      peerPage.getByRole('img', { name: 'График y = a*x+3, a = 3', exact: true }),
    ).toBeVisible();
    await draw(ownerPage);
    await expect
      .poll(async () => records(await exported(owner, origin, id), 'draw')[0]?.props.isComplete)
      .toBe(true);
    const ink = await shape(owner, origin, id, 'draw');
    await expect(peerPage.locator(`[data-shape-id="${ink.id}"]`)).toBeVisible();
    await confirmed(ownerPage);
    // These are the SDK's actual keyboard history actions, not manual record writes.
    await ownerPage.keyboard.press('ControlOrMeta+z');
    await expect
      .poll(async () => records(await exported(owner, origin, id), 'draw').length)
      .toBe(0);
    await expect(peerPage.locator(`[data-shape-id="${ink.id}"]`)).toHaveCount(0);
    await ownerPage.keyboard.press('ControlOrMeta+Shift+z');
    await expect
      .poll(async () => records(await exported(owner, origin, id), 'draw'))
      .toEqual([ink]);
    await expect(peerPage.locator(`[data-shape-id="${ink.id}"]`)).toBeVisible();
    await Promise.all([confirmed(ownerPage), confirmed(peerPage)]);
    await Promise.all([ownerPage.reload(), peerPage.reload()]);
    await Promise.all([ready(ownerPage), ready(peerPage)]);
    await expect(peerPage.locator(`[data-shape-id="${ink.id}"]`)).toBeVisible();
    expect(records(await exported(owner, origin, id), 'draw')).toEqual([ink]);
    expect((await shape(owner, origin, id, 'math-graph')).props).toMatchObject({
      a: 3,
      expression: 'a*x+3',
    });
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('удаление соседом сохраняет черновики, офлайн-штрих и несохранённые исходники попадают в recovery JSON', async ({
  browser,
  baseURL,
}) => {
  const origin = baseURL!;
  const contexts: BrowserContext[] = [];
  const errors: string[] = [];
  try {
    const { owner, peer, ownerPage, peerPage, id } = await setup(browser, origin, contexts, errors);
    await ownerPage.getByRole('button', { name: 'Python', exact: true }).click();
    await ownerPage
      .getByRole('textbox', { name: 'Исходный код Python', exact: true })
      .fill('print("base")\n');
    await ownerPage.getByRole('button', { name: 'Применить код', exact: true }).click();
    await expect
      .poll(async () => (await shape(owner, origin, id, 'code-python')).props.source)
      .toBe('print("base")\n');
    const python = await shape(owner, origin, id, 'code-python');
    await confirmed(ownerPage);
    await ownerPage
      .getByRole('textbox', { name: 'Исходный код Python', exact: true })
      .fill('print("keep deleted draft")\n');
    await expect(peerPage.locator('.board-python')).toBeVisible();
    await select(peerPage, '[data-shape-type="code-python"]');
    await peerPage.keyboard.press('Delete');
    await expect
      .poll(async () => records(await exported(owner, origin, id), 'code-python').length)
      .toBe(0);
    await expect(ownerPage.locator('.board-python')).toHaveCount(0);
    expect((await recovery(ownerPage)).pythonDrafts[python.id].source).toBe(
      'print("keep deleted draft")\n',
    );
    await ownerPage.getByRole('button', { name: 'Формулу', exact: true }).click();
    await ownerPage.getByLabel('Исходная формула', { exact: true }).fill('x+1');
    await ownerPage.getByRole('button', { name: 'Применить', exact: true }).click();
    await expect
      .poll(async () => (await shape(owner, origin, id, 'math-formula')).props.source)
      .toBe('x+1');
    const formula = await shape(owner, origin, id, 'math-formula');
    await confirmed(ownerPage);
    await ownerPage.getByLabel('Исходная формула', { exact: true }).fill('x+99');
    await expect(peerPage.locator('.board-formula')).toBeVisible();
    await select(peerPage, '[data-shape-type="math-formula"]');
    await peerPage.keyboard.press('Delete');
    await expect
      .poll(async () => records(await exported(owner, origin, id), 'math-formula').length)
      .toBe(0);
    await expect(ownerPage.locator('.board-formula')).toHaveCount(0);
    const deleted = await recovery(ownerPage);
    expect(deleted.mathDrafts[formula.id].draft.source).toBe('x+99');
    expect(deleted.pythonDrafts[python.id].source).toBe('print("keep deleted draft")\n');
    await owner.setOffline(true);
    await expect(ownerPage.locator('.board-connection')).toContainText('Нет соединения');
    await draw(ownerPage);
    expect(
      records(await api<Document>(peer, origin, `/api/board-access/${id}/export`), 'draw'),
    ).toHaveLength(0);
    const offline = await recovery(ownerPage);
    expect(offline.format).toBe('tutorflow-board-recovery');
    expect(offline.unconfirmedChanges).toBe(true);
    expect(records(offline.board, 'draw')).toHaveLength(1);
    expect(records(offline.board, 'draw')[0].props.isComplete).toBe(true);
    expect(offline.pythonDrafts[python.id].source).toBe('print("keep deleted draft")\n');
    expect(offline.mathDrafts[formula.id].draft.source).toBe('x+99');
    await owner.setOffline(false);
    await expect
      .poll(async () => records(await exported(owner, origin, id), 'draw').length)
      .toBe(1);
    await confirmed(ownerPage);
    await expect(ownerPage.getByTestId('board-editor')).toHaveAttribute('data-dirty', 'true');
    expect(records(await exported(owner, origin, id), 'code-python')).toHaveLength(0);
    expect(records(await exported(owner, origin, id), 'math-formula')).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('browser Back сохраняет грязный черновик при отмене и выходит только после явного подтверждения', async ({
  browser,
  baseURL,
}) => {
  const origin = baseURL!;
  if (!ownerStorage) throw new Error('Synthetic owner session is not ready');
  const context = await browser.newContext({
    baseURL: origin,
    storageState: ownerStorage,
    viewport: { width: 1440, height: 1000 },
  });
  try {
    const title = `Навигация ${randomUUID()}`;
    const board = await api<{ id: string }>(context, origin, '/api/boards', 'POST', {
      title,
      requestId: randomUUID(),
    });
    const page = await context.newPage();
    await page.goto('/boards');
    await page.getByRole('link', { name: title, exact: true }).click();
    await ready(page);
    await page.getByRole('button', { name: 'Python', exact: true }).click();
    await shape(context, origin, board.id, 'code-python');
    await confirmed(page);
    const code = page.getByRole('textbox', { name: 'Исходный код Python', exact: true });
    await code.fill('print("navigation draft")\n');
    await expect(page.getByTestId('board-editor')).toHaveAttribute('data-dirty', 'true');
    const recovered = await recovery(page);
    expect(
      Object.values(recovered.pythonDrafts).some(
        (draft) => draft.source === 'print("navigation draft")\n',
      ),
    ).toBe(true);
    await page.goBack();
    const guard = page.getByRole('dialog', { name: 'Есть несохранённые изменения', exact: true });
    await expect(guard).toBeVisible({ timeout: 2000 });
    await guard.getByRole('button', { name: 'Остаться на доске', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/boards/${board.id}`);
    await expect(code).toHaveText('print("navigation draft")\n');
    await page.goBack();
    await expect(guard).toBeVisible();
    await guard.getByRole('button', { name: 'Выйти без сохранения', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/boards`);
    expect((await shape(context, origin, board.id, 'code-python')).props).toMatchObject({
      source: '',
      version: 1,
    });
  } finally {
    await context.close();
  }
});

test('конфликт одного поля разрешается явно, одновременная проигравшая правка остаётся в recovery', async ({
  browser,
  baseURL,
}) => {
  const origin = baseURL!;
  const contexts: BrowserContext[] = [];
  const errors: string[] = [];
  try {
    const { owner, ownerPage, peerPage, id } = await setup(browser, origin, contexts, errors);
    await ownerPage.getByRole('button', { name: 'График', exact: true }).click();
    const graph = await shape(owner, origin, id, 'math-graph');
    await expect(peerPage.locator('[data-shape-type="math-graph"]')).toBeVisible();
    await Promise.all([confirmed(ownerPage), confirmed(peerPage)]);
    await select(peerPage, '[data-shape-type="math-graph"]');
    await ownerPage.getByLabel('Параметр a', { exact: true }).fill('2');
    await peerPage.getByLabel('Параметр a', { exact: true }).fill('3');
    await peerPage.getByRole('button', { name: 'Применить', exact: true }).click();
    await expect.poll(async () => (await shape(owner, origin, id, 'math-graph')).props.a).toBe(3);
    await expect(ownerPage.locator('.board-conflict')).toContainText('те же поля: a');
    await ownerPage.getByRole('button', { name: 'Применить', exact: true }).click();
    await expect(ownerPage.getByRole('alert')).toContainText('способ разрешения конфликта');
    expect((await shape(owner, origin, id, 'math-graph')).props.a).toBe(3);
    await expect(ownerPage.getByLabel('Параметр a', { exact: true })).toHaveValue('2');
    // The peer's submitted value must be durably confirmed before the owner
    // deliberately replaces it; otherwise that peer still has a recoverable draft.
    await confirmed(peerPage);
    await expect(peerPage.getByTestId('board-editor')).toHaveAttribute('data-dirty', 'false');
    await ownerPage.getByRole('button', { name: 'Оставить мои значения', exact: true }).click();
    await ownerPage.getByRole('button', { name: 'Применить', exact: true }).click();
    await expect.poll(async () => (await shape(owner, origin, id, 'math-graph')).props.a).toBe(2);
    await Promise.all([confirmed(ownerPage), confirmed(peerPage)]);
    for (const page of [ownerPage, peerPage])
      await expect(page.getByTestId('board-editor')).toHaveAttribute('data-dirty', 'false');
    await ownerPage.getByLabel('Параметр a', { exact: true }).fill('4');
    await peerPage.getByLabel('Параметр a', { exact: true }).fill('5');
    await Promise.all([
      ownerPage.getByRole('button', { name: 'Применить', exact: true }).click(),
      peerPage.getByRole('button', { name: 'Применить', exact: true }).click(),
    ]);
    await Promise.all([confirmed(ownerPage), confirmed(peerPage)]);
    const winner = Number((await shape(owner, origin, id, 'math-graph')).props.a);
    expect([4, 5]).toContain(winner);
    const loserPage = winner === 4 ? peerPage : ownerPage;
    const winnerPage = winner === 4 ? ownerPage : peerPage;
    await expect(loserPage.locator('.board-conflict')).toContainText('те же поля: a');
    await expect(loserPage.getByTestId('board-editor')).toHaveAttribute('data-dirty', 'true');
    await expect(winnerPage.getByTestId('board-editor')).toHaveAttribute('data-dirty', 'false');
    const recovered = (await recovery(loserPage)).mathDrafts[graph.id] as unknown as {
      draft: { a: number };
    };
    expect(recovered.draft.a).toBe(winner === 4 ? 5 : 4);
    for (const page of [ownerPage, peerPage])
      await expect(
        page.getByRole('img', { name: `График y = a*sin(x), a = ${winner}`, exact: true }),
      ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { test, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import type { Board, BoardInvitation, BoardLinks } from '../../shared/boards';
import type { Lesson, Student } from '../../shared/domain';

interface ShapeRecord {
  id: string;
  type: string;
  props: Record<string, unknown>;
}
interface BoardDocument {
  format: string;
  document: { documents: { state: ShapeRecord }[] };
}
interface WireEvent {
  page: string;
  event: string;
  type?: string;
  keys?: string[];
  presenceTimestamp?: number;
  diff?: { recordType: string; operation: string; keys: string[]; propKeys: string[] }[];
}

function observeWire(page: Page, name: string, events: WireEvent[]) {
  page.on('websocket', (socket) => {
    if (!new URL(socket.url()).pathname.startsWith('/api/board-access/')) return;
    const record = (event: WireEvent) => {
      if (events.length < 600) events.push(event);
    };
    record({ page: name, event: 'open' });
    socket.on('framesent', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload)) as Record<string, unknown>;
        let presenceTimestamp: number | undefined;
        const pending: unknown[] = [message.presence];
        while (pending.length) {
          const value = pending.pop();
          if (!value || typeof value !== 'object') continue;
          for (const [key, child] of Object.entries(value)) {
            if (key === 'lastActivityTimestamp') {
              const candidates: unknown[] = Array.isArray(child) ? child.flat(Infinity) : [child];
              presenceTimestamp = candidates.find(
                (part): part is number => typeof part === 'number' && part > 1e12,
              );
            }
            if (child && typeof child === 'object') pending.push(child);
          }
        }
        record({
          page: name,
          event: 'sent',
          type: typeof message.type === 'string' ? message.type : 'unknown',
          keys: Object.keys(message).sort(),
          presenceTimestamp,
          diff:
            message.diff && typeof message.diff === 'object'
              ? Object.entries(message.diff).map(([id, operation]) => {
                  const op = Array.isArray(operation) ? operation : [];
                  const record =
                    op[1] && typeof op[1] === 'object' ? (op[1] as Record<string, unknown>) : {};
                  const props = Array.isArray(record.props) ? record.props[1] : record.props;
                  return {
                    recordType: id.split(':')[0],
                    operation: String(op[0]),
                    keys: Object.keys(record).sort(),
                    propKeys: props && typeof props === 'object' ? Object.keys(props).sort() : [],
                  };
                })
              : undefined,
        });
      } catch {
        record({ page: name, event: 'sent-chunk' });
      }
    });
    socket.on('close', () => record({ page: name, event: 'close' }));
    socket.on('socketerror', () => record({ page: name, event: 'error' }));
  });
}

async function json<T>(
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

// All boards here are isolated by ID; reuse one synthetic owner session in memory
// so expanding browser coverage does not exhaust the real signup limiter.
let syntheticOwnerCookies: Awaited<ReturnType<BrowserContext['cookies']>> | undefined;
test.afterAll(() => {
  syntheticOwnerCookies = undefined;
});
async function register(context: BrowserContext, origin: string) {
  if (syntheticOwnerCookies) {
    await context.addCookies(syntheticOwnerCookies);
    return;
  }
  await json(context, origin, '/api/auth/sign-up/email', 'POST', {
    name: 'Синтетический преподаватель',
    email: `board-${randomUUID()}@tutorflow.test`,
    password: 'OnlySyntheticBoardTest123!',
  });
  syntheticOwnerCookies = await context.cookies();
}

function records(document: BoardDocument, type: string) {
  return document.document.documents
    .map((entry) => entry.state)
    .filter((record) => record.type === type);
}

const boardExport = (context: BrowserContext, origin: string, id: string) =>
  json<BoardDocument>(context, origin, `/api/boards/${id}/export`);

async function shape(context: BrowserContext, origin: string, id: string, type: string) {
  await expect
    .poll(async () => records(await boardExport(context, origin, id), type).length)
    .toBeGreaterThan(0);
  return records(await boardExport(context, origin, id), type)[0];
}

async function ready(page: Page, editable = true) {
  await expect(page.locator('.tlui-layout')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.tl-loading')).toHaveCount(0);
  if (editable)
    await expect(page.getByRole('button', { name: 'Формулу', exact: true })).toBeEnabled();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
}

async function saved(page: Page) {
  await expect(page.locator('.board-editor')).toHaveAttribute('data-dirty', 'false', {
    timeout: 20000,
  });
  await expect(page.locator('.board-editor')).toHaveAttribute('data-proof', 'confirmed', {
    timeout: 20000,
  });
  await expect(page.locator('.board-connection')).not.toContainText(
    /Нет соединения|Ошибка|отклонил/,
  );
}

async function setFormula(page: Page, source: string) {
  await page.getByLabel('Исходная формула', { exact: true }).fill(source);
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
}

async function management(page: Page) {
  await page.getByRole('button', { name: 'Управление', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Управление доской', exact: true });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function invitation(page: Page, role: 'editor' | 'viewer') {
  const drawer = await management(page);
  await drawer.locator('summary').filter({ hasText: 'Пригласить и отозвать доступ' }).click();
  await drawer.getByLabel('Права участника', { exact: true }).selectOption(role);
  await drawer.getByRole('button', { name: 'Создать приглашение', exact: true }).click();
  const url = await drawer.getByLabel('Ссылка приглашения', { exact: true }).inputValue();
  await drawer.getByRole('button', { name: 'Закрыть', exact: true }).click();
  return url;
}

async function join(
  page: Page,
  url: string,
  id: string,
  owner: BrowserContext,
  origin: string,
  role: 'editor' | 'viewer',
) {
  const requests: { path: string; method: string }[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) requests.push({ path, method: request.method() });
  });
  const checked = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/board-access/${id}/session`,
  );
  await page.goto(url);
  await checked;
  await expect(page.getByRole('button', { name: 'Присоединиться', exact: true })).toBeVisible();
  const checkedAgain = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/board-access/${id}/session`,
  );
  await page.reload();
  await checkedAgain;
  await expect(page.getByRole('button', { name: 'Присоединиться', exact: true })).toBeVisible();
  expect(requests.some((request) => request.path.endsWith('/redeem'))).toBe(false);
  const before = await json<BoardInvitation[]>(owner, origin, `/api/boards/${id}/invites`);
  expect(/^#[0-9a-f]{64}$/.test(new URL(url).hash)).toBe(true);
  expect(before.find((invite) => invite.role === role)?.uses).toBe(0);
  await page.getByRole('button', { name: 'Присоединиться', exact: true }).click();
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  await ready(page, false);
  const after = await json<BoardInvitation[]>(owner, origin, `/api/boards/${id}/invites`);
  expect(after.find((invite) => invite.role === role)?.uses).toBe(1);
  expect(requests.filter((request) => request.path.endsWith('/redeem'))).toHaveLength(1);
  expect(requests.every((request) => request.path.startsWith(`/api/board-access/${id}/`))).toBe(
    true,
  );
  await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toHaveCount(0);
  return requests;
}

async function responsive(page: Page, info: TestInfo, name: string, reload = false) {
  const live = (await page.getByTestId('board-editor').count()) > 0;
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
    if (reload || live) {
      await page.reload();
      await ready(page, false);
    }
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    if (live) {
      await saved(page);
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const canvas = document
                .querySelector('[data-testid="canvas"]')
                ?.getBoundingClientRect();
              if (!canvas) return false;
              return [
                ...document.querySelectorAll(
                  '[data-shape-type="math-formula"], [data-shape-type="code-python"]',
                ),
              ].some((node) => {
                const r = node.getBoundingClientRect();
                return (
                  r.right > Math.max(canvas.left, 0) &&
                  r.left < Math.min(canvas.right, innerWidth) &&
                  r.bottom > Math.max(canvas.top, 0) &&
                  r.top < Math.min(canvas.bottom, innerHeight)
                );
              });
            }),
          { message: 'Saved teaching material must be visible when opening this viewport' },
        )
        .toBe(true);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      `${name} overflow at ${width}`,
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`${name}-${width}.png`), fullPage: false });
  }
}

test('доска сохраняет редактируемые формулы, графики, геометрию и код после перезагрузки', async ({
  browser,
  baseURL,
}, info) => {
  const origin = baseURL!;
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  const errors: string[] = [];
  try {
    await register(context, origin);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/boards');
    await page.getByRole('button', { name: 'Создать доску', exact: true }).click();
    const creation = page.getByRole('dialog', { name: 'Новая доска', exact: true });
    await creation
      .getByLabel('Название доски', { exact: true })
      .fill('Редактируемые учебные объекты');
    await creation.getByRole('button', { name: 'Создать доску', exact: true }).click();
    await expect(page.locator('.board-topbar h1')).toHaveText('Редактируемые учебные объекты');
    const id = new URL(page.url()).pathname.split('/').pop()!;
    await ready(page);
    await page.getByTestId('tools.draw').click();
    const canvas = await page.getByTestId('canvas').boundingBox();
    if (!canvas) throw new Error('Нативная область рисования недоступна');
    const start = { x: canvas.x + canvas.width * 0.18, y: canvas.y + canvas.height * 0.3 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 105, start.y + 35, { steps: 8 });
    await page.mouse.move(start.x + 130, start.y + 10, { steps: 4 });
    await page.mouse.up();
    await page.getByTestId('tools.select').click();
    await expect
      .poll(
        async () => records(await boardExport(context, origin, id), 'draw')[0]?.props.isComplete,
      )
      .toBe(true);
    const ink = await shape(context, origin, id, 'draw');
    expect(ink.props).toMatchObject({ isComplete: true, isPen: false });
    const segments = ink.props.segments as { type: string; path: string }[];
    expect(
      segments.some((segment) => segment.type === 'free' && segment.path.length > 16),
      'A native multipoint freehand stroke must be persisted',
    ).toBe(true);
    // Native pointer actions catch editor recreation caused by unstable SDK
    // configuration props; DOM dispatch would conceal that regression.
    await page.getByRole('button', { name: 'Формулу', exact: true }).click();
    await setFormula(page, '\\frac{x^2}{2}+1');
    await expect
      .poll(async () => (await shape(context, origin, id, 'math-formula')).props.source)
      .toBe('\\frac{x^2}{2}+1');
    await saved(page);
    const formula = await shape(context, origin, id, 'math-formula');
    const mathDraft = '\\frac{x^3}{3}+2';
    await page.getByLabel('Исходная формула', { exact: true }).fill(mathDraft);
    await expect(page.locator('.board-editor')).toHaveAttribute('data-dirty', 'true');
    const recoveryEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Экспорт для восстановления', exact: true }).click();
    const recovered = JSON.parse(await readFile((await (await recoveryEvent).path())!, 'utf8')) as {
      format: string;
      mathDrafts: Record<string, { draft: { source: string } }>;
    };
    expect(recovered.format).toBe('tutorflow-board-recovery');
    expect(recovered.mathDrafts[formula.id].draft.source).toBe(mathDraft);
    const blank = await page.getByTestId('canvas').boundingBox();
    if (!blank) throw new Error('Нативная область рисования недоступна');
    await page.mouse.click(blank.x + 80, blank.y + 100);
    await expect(page.getByLabel('Исходная формула', { exact: true })).toHaveCount(0);
    const formulaBox = await page.locator('.board-formula').boundingBox();
    if (!formulaBox) throw new Error('Формула недоступна');
    await page.mouse.click(
      formulaBox.x + formulaBox.width / 2,
      formulaBox.y + formulaBox.height / 2,
    );
    await expect(page.getByLabel('Исходная формула', { exact: true })).toHaveValue(mathDraft);
    await page.getByRole('button', { name: 'Применить', exact: true }).click();
    await expect
      .poll(async () => (await shape(context, origin, id, 'math-formula')).props.source)
      .toBe(mathDraft);
    await saved(page);
    await setFormula(page, '\\frac{x^2}{2}+1');
    await expect
      .poll(async () => (await shape(context, origin, id, 'math-formula')).props.source)
      .toBe('\\frac{x^2}{2}+1');
    await saved(page);
    await page.getByRole('button', { name: 'График', exact: true }).click();
    await page.getByLabel('y =', { exact: true }).fill('a*sin(x)');
    await page.getByLabel('Параметр a', { exact: true }).fill('2');
    await page.getByRole('button', { name: 'Применить', exact: true }).click();
    await expect
      .poll(async () => (await shape(context, origin, id, 'math-graph')).props)
      .toMatchObject({ expression: 'a*sin(x)', a: 2 });
    await page.getByRole('button', { name: 'Геометрию', exact: true }).click();
    await page.getByLabel('Фигура', { exact: true }).selectOption('circle');
    await page.getByLabel('Радиус', { exact: true }).fill('4');
    await page.getByRole('button', { name: 'Применить', exact: true }).click();
    await expect
      .poll(async () => (await shape(context, origin, id, 'math-geometry')).props)
      .toMatchObject({ kind: 'circle', radius: 4 });
    await page.getByRole('button', { name: 'Python', exact: true }).click();
    const code = page.getByRole('textbox', { name: 'Исходный код Python', exact: true });
    await code.fill('print("synthetic lesson")\n');
    await page.getByRole('button', { name: 'Применить код', exact: true }).click();
    await expect
      .poll(async () => (await shape(context, origin, id, 'code-python')).props)
      .toMatchObject({ source: 'print("synthetic lesson")\n', version: 2 });
    await saved(page);
    await code.fill('print("draft survives rename")\n');
    const rename = await management(page);
    await rename
      .getByLabel('Название доски', { exact: true })
      .fill('Переименованные учебные объекты');
    await rename.getByRole('button', { name: 'Сохранить название', exact: true }).click();
    await expect(page.locator('.board-topbar h1')).toHaveText('Переименованные учебные объекты');
    await rename.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect(code).toHaveText('print("draft survives rename")\n');
    await expect(page.locator('.board-editor')).toHaveAttribute('data-dirty', 'true');
    await code.fill('print("synthetic lesson")\n');
    await saved(page);
    await page.reload();
    await ready(page);
    const persisted = await boardExport(context, origin, id);
    expect(records(persisted, 'draw')).toEqual([ink]);
    expect(records(persisted, 'math-formula')[0].props.source).toBe('\\frac{x^2}{2}+1');
    expect(records(persisted, 'math-graph')[0].props).toMatchObject({
      expression: 'a*sin(x)',
      a: 2,
    });
    expect(records(persisted, 'math-geometry')[0].props).toMatchObject({
      kind: 'circle',
      radius: 4,
    });
    expect(records(persisted, 'code-python')[0].props).toMatchObject({
      source: 'print("synthetic lesson")\n',
      version: 2,
    });
    await responsive(page, info, 'board-owner');
    const drawer = await management(page);
    await expect(drawer).toBeVisible();
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
      expect(
        await page.evaluate(() => {
          const toolbar = document.querySelector('.tlui-toolbar');
          if (!toolbar) return false;
          const box = toolbar.getBoundingClientRect();
          return !document
            .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
            ?.closest('.tl-container');
        }),
        `native toolbar overlays management at ${width}`,
      ).toBe(true);
    }
    const downloadEvent = page.waitForEvent('download');
    await drawer.getByRole('button', { name: 'Экспорт доски в JSON', exact: true }).click();
    const download = await downloadEvent;
    const exported = JSON.parse(await readFile((await download.path())!, 'utf8')) as BoardDocument;
    expect(exported.format).toBe('tutorflow-board');
    expect(records(exported, 'code-python')[0].props.source).toBe('print("synthetic lesson")\n');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('независимые editor/viewer синхронизируются, переживают reconnect и теряют отозванный доступ', async ({
  browser,
  baseURL,
}, info) => {
  const origin = baseURL!;
  const contexts: BrowserContext[] = [];
  const errors: string[] = [];
  const wire: WireEvent[] = [];
  const createContext = async () => {
    const context = await browser.newContext({
      baseURL: origin,
      viewport: { width: 1440, height: 1000 },
    });
    contexts.push(context);
    return context;
  };
  try {
    const owner = await createContext();
    const editor = await createContext();
    const viewer = await createContext();
    await register(owner, origin);
    const board = await json<Board>(owner, origin, '/api/boards', 'POST', {
      title: 'Совместный синтетический материал',
      requestId: randomUUID(),
    });
    const ownerPage = await owner.newPage();
    observeWire(ownerPage, 'owner', wire);
    ownerPage.on('pageerror', (error) => errors.push(error.message));
    await ownerPage.goto(`/boards/${board.id}`);
    await ready(ownerPage);
    await ownerPage.getByRole('button', { name: 'Формулу', exact: true }).click();
    await setFormula(ownerPage, 'x+10');
    await expect
      .poll(async () => (await shape(owner, origin, board.id, 'math-formula')).props.source)
      .toBe('x+10');
    await saved(ownerPage);
    const editorUrl = await invitation(ownerPage, 'editor');
    const viewerUrl = await invitation(ownerPage, 'viewer');
    const editorPage = await editor.newPage();
    const viewerPage = await viewer.newPage();
    observeWire(editorPage, 'editor', wire);
    observeWire(viewerPage, 'viewer', wire);
    for (const page of [editorPage, viewerPage])
      page.on('pageerror', (error) => errors.push(error.message));
    const editorRequests = await join(editorPage, editorUrl, board.id, owner, origin, 'editor');
    const viewerRequests = await join(viewerPage, viewerUrl, board.id, owner, origin, 'viewer');
    await expect(editorPage.getByRole('button', { name: 'Формулу', exact: true })).toBeEnabled();
    await expect(viewerPage.getByRole('button', { name: 'Формулу', exact: true })).toHaveCount(0);
    await expect(viewerPage.locator('.board-viewer-label')).toContainText('Только просмотр');
    for (const context of [editor, viewer]) {
      const cookie = (await context.cookies(`${origin}/api/board-access/${board.id}/session`)).find(
        (entry) => entry.name === 'tutorflow_board_session',
      );
      expect(cookie).toMatchObject({
        httpOnly: true,
        sameSite: 'Strict',
        path: `/api/board-access/${board.id}`,
      });
      expect((await context.request.get('/api/me')).status()).toBe(401);
    }
    const viewerCameraBeforeEdit = await viewerPage.locator('.board-formula').boundingBox();
    await setFormula(ownerPage, 'x+11');
    await expect(viewerPage.locator('.board-formula')).toContainText('x+11');
    expect(await viewerPage.locator('.board-formula').boundingBox()).toEqual(
      viewerCameraBeforeEdit,
    );
    await expect(editorPage.locator('.board-formula')).toContainText('x+11');
    await editorPage.getByRole('button', { name: 'График', exact: true }).click();
    await ownerPage.getByLabel('Исходная формула', { exact: true }).fill('x+12');
    await editorPage.getByLabel('y =', { exact: true }).fill('x^2');
    await Promise.all([
      ownerPage.getByRole('button', { name: 'Применить', exact: true }).click(),
      editorPage.getByRole('button', { name: 'Применить', exact: true }).click(),
    ]);
    await expect
      .poll(async () => (await shape(owner, origin, board.id, 'math-graph')).props.expression)
      .toBe('x^2');
    await expect
      .poll(async () => (await shape(owner, origin, board.id, 'math-formula')).props.source)
      .toBe('x+12');
    await expect(viewerPage.locator('.board-formula')).toContainText('x+12');
    await expect(
      ownerPage.getByRole('img', { name: 'График y = x^2, a = 1', exact: true }),
    ).toBeVisible();
    await editor.setOffline(true);
    await expect(editorPage.locator('.board-connection')).toContainText('Нет соединения');
    await editorPage.getByRole('button', { name: 'Геометрию', exact: true }).click();
    await expect(editorPage.locator('.board-editor')).toHaveAttribute('data-dirty', 'true');
    expect(records(await boardExport(owner, origin, board.id), 'math-geometry')).toHaveLength(0);
    await editor.setOffline(false);
    await expect
      .poll(async () => records(await boardExport(owner, origin, board.id), 'math-geometry').length)
      .toBe(1);
    await saved(editorPage);
    await expect(
      viewerPage.getByRole('img', { name: 'Треугольник ABC', exact: true }),
    ).toBeVisible();
    await ownerPage.getByRole('button', { name: 'Python', exact: true }).click();
    const code = ownerPage.getByRole('textbox', { name: 'Исходный код Python', exact: true });
    await code.fill('print("base")\n');
    await ownerPage.getByRole('button', { name: 'Применить код', exact: true }).click();
    const python = await shape(owner, origin, board.id, 'code-python');
    await expect
      .poll(async () => (await shape(owner, origin, board.id, 'code-python')).props.version)
      .toBe(2);
    const viewerWrite = await viewer.request.post(
      `/api/board-access/${board.id}/code/${encodeURIComponent(python.id)}`,
      {
        headers: { Origin: origin },
        data: { expectedVersion: 2, source: 'viewer must not persist' },
      },
    );
    expect(viewerWrite.status()).toBe(403);
    expect((await shape(owner, origin, board.id, 'code-python')).props).toMatchObject({
      source: 'print("base")\n',
      version: 2,
    });
    await code.fill('print("local merge")\n');
    await json(
      editor,
      origin,
      `/api/board-access/${board.id}/code/${encodeURIComponent(python.id)}`,
      'POST',
      { expectedVersion: 2, source: 'print("remote version")\n' },
    );
    await expect(ownerPage.locator('.board-conflict')).toContainText('На доске есть другая версия');
    await ownerPage.getByRole('button', { name: 'Применить код', exact: true }).click();
    await expect(ownerPage.locator('.board-error')).toContainText('черновик сохранён');
    await expect(code).toHaveText('print("local merge")\n');
    await expect(ownerPage.locator('.board-editor')).toHaveAttribute('data-dirty', 'true');
    await ownerPage
      .getByRole('button', { name: 'Использовать моё объединение', exact: true })
      .click();
    await ownerPage.getByRole('button', { name: 'Применить код', exact: true }).click();
    await expect
      .poll(async () => (await shape(owner, origin, board.id, 'code-python')).props)
      .toMatchObject({ source: 'print("local merge")\n', version: 4 });
    await saved(ownerPage);
    await ownerPage.reload();
    await ready(ownerPage);
    await expect(ownerPage.locator('.board-python pre')).toHaveText('print("local merge")\n');
    await viewerPage.reload();
    await ready(viewerPage, false);
    await saved(viewerPage);
    await responsive(viewerPage, info, 'board-viewer');
    expect(viewerRequests.filter((request) => request.path.endsWith('/redeem'))).toHaveLength(1);
    const drawer = await management(ownerPage);
    await drawer.locator('summary').filter({ hasText: 'Пригласить и отозвать доступ' }).click();
    await drawer
      .getByRole('listitem')
      .filter({ hasText: 'Редактирование' })
      .getByRole('button', { name: 'Отозвать доступ', exact: true })
      .click();
    await expect
      .poll(async () =>
        (await editor.request.get(`/api/board-access/${board.id}/session`)).status(),
      )
      .toBe(404);
    await expect(editorPage.locator('.board-connection')).toContainText(
      /Нет соединения|Ошибка|отклонил/,
      { timeout: 15000 },
    );
    expect((await viewer.request.get(`/api/board-access/${board.id}/session`)).status()).toBe(200);
    const denied = await editor.request.post(
      `/api/board-access/${board.id}/code/${encodeURIComponent(python.id)}`,
      { headers: { Origin: origin }, data: { expectedVersion: 4, source: 'must not persist' } },
    );
    expect(denied.status()).toBe(404);
    expect((await shape(owner, origin, board.id, 'code-python')).props).toMatchObject({
      source: 'print("local merge")\n',
      version: 4,
    });
    editorPage.once('dialog', (dialog) => void dialog.accept());
    await editorPage.reload();
    await expect(
      editorPage.getByRole('heading', { name: 'Доска недоступна', exact: true }),
    ).toBeVisible();
    expect(
      editorRequests.every((request) => request.path.startsWith(`/api/board-access/${board.id}/`)),
    ).toBe(true);
    expect(
      viewerRequests.every((request) => request.path.startsWith(`/api/board-access/${board.id}/`)),
    ).toBe(true);
    expect(errors).toEqual([]);
    expect(
      wire.some((event) => (event.presenceTimestamp ?? 0) > 1e12),
      'Real native pointer presence carries an epoch timestamp',
    ).toBe(true);
  } finally {
    await writeFile(info.outputPath('board-wire-summary.json'), JSON.stringify(wire, null, 2));
    await info.attach('board-wire-summary', {
      body: Buffer.from(JSON.stringify(wire, null, 2)),
      contentType: 'application/json',
    });
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('карточка урока открывает рабочую доску, а повтор привязки сохраняет одну версию', async ({
  browser,
  baseURL,
}) => {
  const origin = baseURL!;
  const context = await browser.newContext({ baseURL: origin });
  try {
    await register(context, origin);
    const student = await json<Student>(context, origin, '/api/students', 'POST', {
      name: 'Синтетический ученик доски',
      subject: 'Математика',
      level: '',
      price: 100000,
      duration: 60,
      goal: '',
      notes: '',
    });
    const lesson = await json<Lesson>(context, origin, '/api/lessons', 'POST', {
      studentId: student.id,
      startsAt: '2020-04-02T10:00:00.000Z',
      topic: 'Доска прямо из урока',
      allowConflict: false,
    });
    const board = await json<Board>(context, origin, '/api/boards', 'POST', {
      title: 'Материал для продолжения',
      requestId: randomUUID(),
    });
    await json(context, origin, `/api/boards/${board.id}/links`, 'POST', {
      studentId: student.id,
      lessonId: lesson.id,
    });
    const page = await context.newPage();
    await page.goto(`/lessons/${lesson.id}`);
    const material = page.getByRole('region', { name: 'Материалы урока' });
    await expect(material.getByText(board.title)).toBeVisible();
    await material.getByRole('link', { name: 'Продолжить доску', exact: true }).click();
    await ready(page);
    await page.getByRole('button', { name: 'Формулу', exact: true }).click();
    await setFormula(page, 'x+1');
    await saved(page);
    let failed = false;
    await page.route(`**/api/boards/${board.id}/links`, async (route) => {
      if (route.request().method() === 'POST' && !failed) {
        failed = true;
        await route.fulfill({ status: 503, json: { error: 'Проверочная ошибка связи' } });
      } else await route.continue();
    });
    await page.getByRole('button', { name: 'Сохранить версию к уроку', exact: true }).click();
    await expect(
      page.getByText('Версия сохранена. Связь с уроком пока не записана.'),
    ).toBeVisible();
    let versions = await json<{ id: string }[]>(
      context,
      origin,
      `/api/boards/${board.id}/versions`,
    );
    expect(versions).toHaveLength(1);
    const versionId = versions[0].id;
    await page.reload();
    await ready(page);
    await expect(page.getByText('Версия сохранена. Завершите привязку к уроку.')).toBeVisible();
    await page.getByRole('button', { name: 'Повторить привязку', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Версия урока сохранена' })).toBeVisible();
    versions = await json<{ id: string }[]>(context, origin, `/api/boards/${board.id}/versions`);
    expect(versions.map((item) => item.id)).toEqual([versionId]);
    const formula = await page.locator('.board-formula').boundingBox();
    if (!formula) throw new Error('Формула недоступна после перезагрузки');
    await page.mouse.click(formula.x + formula.width / 2, formula.y + formula.height / 2);
    await setFormula(page, 'x+2');
    await saved(page);
    await page.getByRole('link', { name: 'К уроку', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/lessons/${lesson.id}$`));
    await material.getByRole('link', { name: 'Открыть версию урока', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`version=${versionId}`));
    await ready(page, false);
    await expect(page.locator('.board-formula')).toContainText('x+1');
    expect((await shape(context, origin, board.id, 'math-formula')).props.source).toBe('x+2');
  } finally {
    await context.close();
  }
});

test('на низком экране видны холст и панель формулы', async ({ browser, baseURL }) => {
  const origin = baseURL!;
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 740, height: 365 },
    hasTouch: true,
  });
  try {
    await register(context, origin);
    const board = await json<Board>(context, origin, '/api/boards', 'POST', {
      title: 'Проверка экрана',
      requestId: randomUUID(),
    });
    const page = await context.newPage();
    await page.goto(`/boards/${board.id}`);
    await ready(page);
    await page.getByRole('button', { name: 'Формулу', exact: true }).tap();
    const inspector = page.getByRole('complementary', { name: 'Данные выбранного объекта' });
    await expect(inspector).toBeInViewport();
    const box = await inspector.boundingBox();
    expect(box && box.y + box.height).toBeLessThanOrEqual(365.5);
    await setFormula(page, 'x+7');
    await saved(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await expect(page.getByRole('button', { name: 'Формулу', exact: true })).toBeInViewport();
    await expect(inspector).toBeInViewport();
    await expect
      .poll(async () => (await shape(context, origin, board.id, 'math-formula')).props.source)
      .toBe('x+7');
  } finally {
    await context.close();
  }
});

test('прошлый урок открывает неизменяемую v1 после live v2, а копия и удаление связей сохраняют материалы', async ({
  browser,
  baseURL,
}, info) => {
  const origin = baseURL!;
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  const errors: string[] = [];
  try {
    await register(context, origin);
    const student = await json<Student>(context, origin, '/api/students', 'POST', {
      name: 'Синтетический ученик истории',
      subject: 'Математика',
      level: '',
      price: 100000,
      duration: 60,
      goal: '',
      notes: 'CRM only synthetic note',
    });
    const lesson = await json<Lesson>(context, origin, '/api/lessons', 'POST', {
      studentId: student.id,
      startsAt: '2020-04-01T10:00:00.000Z',
      topic: 'Синтетическая история',
      allowConflict: false,
    });
    const board = await json<Board>(context, origin, '/api/boards', 'POST', {
      title: 'История урока',
      requestId: randomUUID(),
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/boards/${board.id}`);
    await ready(page);
    await page.getByRole('button', { name: 'Формулу', exact: true }).click();
    await setFormula(page, 'x+1');
    await expect
      .poll(async () => (await shape(context, origin, board.id, 'math-formula')).props.source)
      .toBe('x+1');
    await saved(page);
    const drawer = await management(page);
    await drawer.locator('summary').filter({ hasText: 'Сохранённые версии' }).click();
    await drawer.getByLabel('Название версии', { exact: true }).fill('Материал прошлого урока v1');
    await drawer.getByRole('button', { name: 'Сохранить версию', exact: true }).click();
    await expect(drawer.getByText('Материал прошлого урока v1', { exact: true })).toBeVisible();
    const [version] = await json<{ id: string; label: string }[]>(
      context,
      origin,
      `/api/boards/${board.id}/versions`,
    );
    await drawer.locator('summary').filter({ hasText: 'Ученики и занятия' }).click();
    await drawer.getByLabel('Ученик', { exact: true }).selectOption(student.id);
    await drawer.getByRole('button', { name: 'Связать с учеником', exact: true }).click();
    await drawer.getByLabel('Занятие', { exact: true }).selectOption(lesson.id);
    await drawer.getByLabel('Материал занятия', { exact: true }).selectOption(version.id);
    await drawer.getByRole('button', { name: 'Связать с занятием', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await json<BoardLinks>(context, origin, `/api/boards/${board.id}/links`)).lessons[0]
            ?.snapshotId,
      )
      .toBe(version.id);
    await drawer.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await setFormula(page, 'x+2');
    await expect
      .poll(async () => (await shape(context, origin, board.id, 'math-formula')).props.source)
      .toBe('x+2');
    await saved(page);
    await page.goto(`/boards?lessonId=${lesson.id}&studentId=${student.id}`);
    const sockets: string[] = [];
    const observe = (socket: { url: () => string }) => {
      if (new URL(socket.url()).pathname === `/api/board-access/${board.id}/sync`)
        sockets.push('unexpected live room');
    };
    page.on('websocket', observe);
    await page.getByRole('link', { name: 'Открыть версию занятия', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`version=${version.id}`));
    await expect(page.locator('.board-snapshot h1')).toHaveText('Материал прошлого урока v1');
    await expect(page.locator('.board-snapshot-notice')).toContainText(
      'Сохранённая версия не изменяется',
    );
    await ready(page, false);
    await expect(page.locator('.board-formula')).toContainText('x+1');
    await expect(page.getByRole('button', { name: 'Формулу', exact: true })).toHaveCount(0);
    await responsive(page, info, 'saved-version', true);
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'JSON', exact: true }).click();
    const downloaded = await downloadEvent;
    const frozen = JSON.parse(await readFile((await downloaded.path())!, 'utf8')) as BoardDocument;
    expect(records(frozen, 'math-formula')[0].props.source).toBe('x+1');
    expect(sockets).toEqual([]);
    page.off('websocket', observe);
    await page.getByRole('button', { name: 'Восстановить копией', exact: true }).click();
    await expect(page).not.toHaveURL(new RegExp(`/boards/${board.id}([?]|$)`));
    await ready(page);
    const copyId = new URL(page.url()).pathname.split('/').pop()!;
    expect(copyId).not.toBe(board.id);
    expect(
      records(await boardExport(context, origin, copyId), 'math-formula')[0].props.source,
    ).toBe('x+1');
    expect((await shape(context, origin, board.id, 'math-formula')).props.source).toBe('x+2');
    expect(await json(context, origin, `/api/boards/${copyId}/invites`)).toEqual([]);
    expect(await json(context, origin, `/api/boards/${copyId}/links`)).toEqual({
      lessons: [],
      students: [],
    });
    await saved(page);
    await page.goto(`/boards/${board.id}`);
    await ready(page);
    const original = await management(page);
    await original.locator('summary').filter({ hasText: 'Ученики и занятия' }).click();
    await original.getByRole('button', { name: 'Убрать связь с занятием', exact: true }).click();
    await original.getByRole('button', { name: 'Убрать связь с учеником', exact: true }).click();
    await expect
      .poll(() => json(context, origin, `/api/boards/${board.id}/links`))
      .toEqual({ lessons: [], students: [] });
    expect((await shape(context, origin, board.id, 'math-formula')).props.source).toBe('x+2');
    expect(
      records(
        await json<BoardDocument>(
          context,
          origin,
          `/api/boards/${board.id}/versions/${version.id}/export`,
        ),
        'math-formula',
      )[0].props.source,
    ).toBe('x+1');
    await saved(page);
    await page.goto(`/boards/${copyId}`);
    await ready(page);
    const copied = await management(page);
    await copied.locator('summary').filter({ hasText: 'Удаление доски' }).click();
    await copied.getByRole('button', { name: 'Удалить доску', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Удалить эту доску?', exact: true });
    await confirm.getByRole('button', { name: 'Назад', exact: true }).click();
    expect((await context.request.get(`/api/boards/${copyId}`)).status()).toBe(200);
    await copied.getByRole('button', { name: 'Удалить доску', exact: true }).click();
    await confirm.getByRole('button', { name: 'Удалить доску', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/boards`);
    expect((await context.request.get(`/api/boards/${copyId}`)).status()).toBe(404);
    expect((await context.request.get(`/api/boards/${board.id}`)).status()).toBe(200);
    expect((await context.request.get(`/api/students/${student.id}`)).status()).toBe(200);
    expect((await context.request.get(`/api/lessons/${lesson.id}`)).status()).toBe(200);
    await page.goto(`/boards?lessonId=${lesson.id}&studentId=${student.id}`);
    await page.getByRole('button', { name: 'Создать доску', exact: true }).click();
    const creation = page.getByRole('dialog', { name: 'Новая доска', exact: true });
    await creation.getByLabel('Название доски', { exact: true }).fill('Новая доска из занятия');
    await creation.getByRole('button', { name: 'Создать и связать', exact: true }).click();
    await expect(page.locator('.board-topbar h1')).toHaveText('Новая доска из занятия');
    const createdId = new URL(page.url()).pathname.split('/').pop()!;
    const createdLinks = await json<BoardLinks>(context, origin, `/api/boards/${createdId}/links`);
    expect(createdLinks.students.map((link) => link.studentId)).toEqual([student.id]);
    expect(createdLinks.lessons.map((link) => link.lessonId)).toEqual([lesson.id]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

/** Bounded synthetic two-browser measurement. Never opens the user's stores. */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import type { TLRecord } from '@tldraw/tlschema';
import { createDatabase, migrate, type Database } from '../server/db.js';
import { createApp } from '../server/app.js';
import { BoardRuntime } from '../server/boards/runtime.js';
import { attachBoardSockets } from '../server/boards/socket.js';
import type { Config } from '../server/config.js';

const output = resolve(process.argv[2] ?? '.data/mission-evidence/board-browser-benchmark');
await mkdir(output, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(tmpdir(), 'tutorflow-browser-benchmark-'));
const server = createServer();
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing benchmark port');
const base = `http://127.0.0.1:${address.port}`;
const config: Config = {
  production: false,
  port: address.port,
  appUrl: base,
  secret: randomUUID() + randomUUID(),
  databaseSSL: false,
  dataDir: join(directory, 'crm'),
  boardDir: join(directory, 'boards'),
  boardsEnabled: true,
  aiModel: 'disabled',
  aiDailyLimit: 1,
};
let db: Database | undefined;
let runtime: BoardRuntime | undefined;
let sockets: ReturnType<typeof attachBoardSockets> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const contexts: BrowserContext[] = [];
const errors: string[] = [];
const wire = { sentFrames: 0, receivedFrames: 0, sentBytes: 0, receivedBytes: 0 };
function percentile(samples: number[], fraction: number) {
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] ?? null;
}
async function ready(page: Page) {
  await expect(page.locator('.tlui-layout')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('board-editor')).toHaveAttribute('data-proof', 'confirmed', {
    timeout: 30000,
  });
}
async function api<T>(
  context: BrowserContext,
  path: string,
  method = 'GET',
  data?: unknown,
): Promise<T> {
  const response = await context.request.fetch(`${base}${path}`, {
    method,
    data,
    headers: { Origin: base },
  });
  if (!response.ok()) throw new Error(`Benchmark API ${method} failed: ${response.status()}`);
  return (await response.json()) as T;
}
try {
  db = await createDatabase(config);
  await migrate(db);
  runtime = await BoardRuntime.open(config.boardDir!);
  const { app, boardContext } = createApp(db, config, undefined, runtime);
  app.use('/board-assets/5.6.0', express.static(resolve('node_modules/@tldraw/assets')));
  app.use(express.static(resolve('dist/client'), { index: false }));
  app.get('/{*splat}', (_req, res) => res.sendFile(resolve('dist/client/index.html')));
  server.on('request', app);
  sockets = attachBoardSockets(server, boardContext);
  browser = await chromium.launch();
  const owner = await browser.newContext({ baseURL: base, viewport: { width: 1024, height: 900 } });
  const guest = await browser.newContext({ baseURL: base, viewport: { width: 1024, height: 900 } });
  contexts.push(owner, guest);
  await api(owner, '/api/auth/sign-up/email', 'POST', {
    name: 'Synthetic benchmark',
    email: `benchmark-${randomUUID()}@example.test`,
    password: randomUUID(),
  });
  const board = await api<{ id: string }>(owner, '/api/boards', 'POST', {
    title: 'Synthetic loaded canvas',
    requestId: randomUUID(),
  });
  // Seed real durable records before browser joins; drawing below uses only real pointer events.
  await runtime.run(board.id, (entry) =>
    entry.room.updateStore((store) => {
      for (let i = 0; i < 300; i++) {
        store.put({
          id: `shape:benchmark-${i}`,
          typeName: 'shape',
          type: 'math-formula',
          x: (i % 15) * 260,
          y: Math.floor(i / 15) * 130,
          rotation: 0,
          index: `a1${(i + 1).toString(36).padStart(3, '0')}V`,
          parentId: 'page:page',
          isLocked: false,
          opacity: 1,
          meta: {},
          props: { w: 240, h: 100, source: `\\frac{x^{2}}{${i + 1}}+\\sin(x)` },
        } as TLRecord);
      }
    }),
  );
  const invite = await api<{ token: string }>(owner, `/api/boards/${board.id}/invites`, 'POST', {
    role: 'editor',
    ttlMinutes: 30,
    maxUses: 1,
  });
  for (const context of contexts) {
    // A source string avoids tsx/esbuild function-name helpers in browser serialization.
    await context.addInitScript({
      content: `
      const metrics = { frames: [], longTasks: [] };
      window.benchmarkMetrics = metrics;
      let last = performance.now();
      const frame = (now) => { if (metrics.frames.length < 10000) metrics.frames.push(now-last); last=now; requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
      if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        new PerformanceObserver((list) => { for(const entry of list.getEntries()) if(metrics.longTasks.length<1000) metrics.longTasks.push(entry.duration); }).observe({ type:'longtask', buffered:true });
      }
    `,
    });
  }
  const ownerPage = await owner.newPage(),
    guestPage = await guest.newPage();
  for (const page of [ownerPage, guestPage]) {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('websocket', (ws) => {
      ws.on('framesent', ({ payload }) => {
        wire.sentFrames++;
        wire.sentBytes += typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length;
      });
      ws.on('framereceived', ({ payload }) => {
        wire.receivedFrames++;
        wire.receivedBytes +=
          typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length;
      });
    });
  }
  let start = performance.now();
  await ownerPage.goto(`/boards/${board.id}`);
  await ready(ownerPage);
  const ownerLoadMs = performance.now() - start;
  await guestPage.goto(`/join/${board.id}#${invite.token}`);
  start = performance.now();
  await guestPage.getByRole('button', { name: 'Присоединиться', exact: true }).click();
  await ready(guestPage);
  const guestJoinMs = performance.now() - start;
  const cdpOwner = await owner.newCDPSession(ownerPage),
    cdpGuest = await guest.newCDPSession(guestPage);
  await cdpOwner.send('Performance.enable');
  await cdpGuest.send('Performance.enable');
  const heap = async () =>
    await Promise.all(
      [cdpOwner, cdpGuest].map(async (cdp) => {
        const result = await cdp.send('Performance.getMetrics');
        return result.metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? null;
      }),
    );
  const heapBefore = await heap();
  for (const page of [ownerPage, guestPage])
    await page.evaluate(() => {
      const data = (
        window as unknown as { benchmarkMetrics: { frames: number[]; longTasks: number[] } }
      ).benchmarkMetrics;
      data.frames = [];
      data.longTasks = [];
    });
  const latency: number[] = [];
  await ownerPage.getByTestId('tools.draw').click();
  const canvas = await ownerPage.getByTestId('canvas').boundingBox();
  if (!canvas) throw new Error('Missing actual canvas');
  for (let n = 1; n <= 10; n++) {
    const x = canvas.x + 70,
      y = canvas.y + 110 + n * 12;
    const priorIds = new Set(
      await ownerPage
        .locator('[data-shape-type="draw"]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-shape-id'))),
    );
    await ownerPage.mouse.move(x, y);
    await ownerPage.mouse.down();
    await ownerPage.mouse.move(x + 80, y + 25, { steps: 8 });
    const id = (
      await ownerPage
        .locator('[data-shape-type="draw"]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-shape-id')))
    ).find((id) => id && !priorIds.has(id));
    if (!id) throw new Error('Missing native stroke ID');
    const peerStroke = guestPage.locator(`[data-shape-id="${id}"]`);
    await expect(peerStroke).toBeVisible();
    const path = () =>
      peerStroke
        .locator('path')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('d')).join('|'));
    const before = await path();
    if (!before) throw new Error('No rendered stroke path to observe');
    // Measure a NEW point reaching the guest's rendered SVG, not an already-existing shape count.
    const movedAt = performance.now();
    await ownerPage.mouse.move(x + 120, y + 65, { steps: 4 });
    await ownerPage.mouse.up();
    await expect.poll(path, { intervals: [5], timeout: 10000 }).not.toBe(before);
    latency.push(performance.now() - movedAt);
    await expect(guestPage.locator('[data-shape-type="draw"]')).toHaveCount(n);
  }
  await ownerPage.getByTestId('tools.select').click();
  const shapeBoxBeforePan = await ownerPage
    .locator('[data-shape-id="shape:benchmark-0"]')
    .boundingBox();
  // Native pan/zoom gestures on a loaded document, without SDK state hooks.
  await ownerPage.mouse.move(canvas.x + 400, canvas.y + 300);
  await ownerPage.mouse.down({ button: 'middle' });
  await ownerPage.mouse.move(canvas.x + 480, canvas.y + 350, { steps: 8 });
  await ownerPage.mouse.up({ button: 'middle' });
  await expect
    .poll(
      async () => (await ownerPage.locator('[data-shape-id="shape:benchmark-0"]').boundingBox())?.x,
    )
    .not.toBe(shapeBoxBeforePan?.x);
  const shapeBoxAfterPan = await ownerPage
    .locator('[data-shape-id="shape:benchmark-0"]')
    .boundingBox();
  if (!shapeBoxBeforePan || !shapeBoxAfterPan) throw new Error('Pan lost the observed shape');
  await ownerPage.keyboard.down('Control');
  await ownerPage.mouse.wheel(0, -140);
  await ownerPage.keyboard.up('Control');
  await expect
    .poll(
      async () =>
        (await ownerPage.locator('[data-shape-id="shape:benchmark-0"]').boundingBox())?.width,
    )
    .not.toBe(shapeBoxAfterPan.width);
  await ready(ownerPage);
  await ready(guestPage);
  const exported = await api<{ document: { documents: { state: { type?: string } }[] } }>(
    owner,
    `/api/boards/${board.id}/export`,
  );
  if (
    exported.document.documents.filter(({ state }) => state.type === 'math-formula').length !==
      300 ||
    exported.document.documents.filter(({ state }) => state.type === 'draw').length !== 10
  )
    throw new Error('Durable document count changed unexpectedly');
  const heapAfter = await heap();
  const timing = await Promise.all(
    [ownerPage, guestPage].map((page) =>
      page.evaluate(() => {
        const data = (
          window as unknown as { benchmarkMetrics: { frames: number[]; longTasks: number[] } }
        ).benchmarkMetrics;
        return {
          ...data,
          resources: performance
            .getEntriesByType('resource')
            .map((entry) => (entry as PerformanceResourceTiming).transferSize),
        };
      }),
    ),
  );
  await ownerPage.screenshot({ path: join(output, 'loaded-owner.png') });
  await guestPage.screenshot({ path: join(output, 'loaded-guest.png') });
  // Verify the actual settings flow also themes the lazy native editor.
  await ownerPage.goto('/settings');
  await ownerPage.getByLabel('Тёмное', { exact: true }).check();
  await ownerPage.getByRole('button', { name: 'Сохранить настройки' }).click();
  await expect(ownerPage.locator('html')).toHaveAttribute('data-theme', 'dark');
  await ownerPage.goto(`/boards/${board.id}`);
  await ready(ownerPage);
  await expect(ownerPage.locator('.tl-container')).toHaveClass(/tl-theme__dark/);
  await ownerPage.screenshot({ path: join(output, 'loaded-owner-dark.png') });
  const result = {
    darkThemeThroughSettings: true,
    measuredAt: new Date().toISOString(),
    node: process.version,
    chromium: browser.version(),
    scope:
      'Single local headless Chromium, 300 durable formula records + 10 real drawn strokes, 2 independent contexts, 1024x900 each. No live video, CPU throttling, physical stylus or production capacity claim. Latency is an automation-issued new pointer point to changed guest SVG path, includes command/poll overhead, not display paint. Frame/longtask samples cover interaction; memory samples start after load; JS heap is not total process memory.',
    ownerLoadMs,
    guestJoinMs,
    panChangedRenderedPosition: true,
    zoomChangedRenderedSize: true,
    seedFormulaCount: 300,
    persistedDrawCount: 10,
    pointerMoveToGuestPathUpdateMs: {
      samples: latency,
      median: percentile(latency, 0.5),
      p95: percentile(latency, 0.95),
    },
    browsers: timing.map((data, i) => ({
      frameSamples: data.frames.length,
      frameGapP95Ms: percentile(data.frames, 0.95),
      maxFrameGapMs: Math.max(...data.frames),
      longTaskCount: data.longTasks.length,
      maxLongTaskMs: Math.max(0, ...data.longTasks),
      resourceTransferBytes: data.resources.reduce((a, b) => a + b, 0),
      jsHeapBefore: heapBefore[i],
      jsHeapAfter: heapAfter[i],
    })),
    wire,
    errors,
  };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', {
    mode: 0o600,
  });
  if (errors.length) throw new Error(`Browser reported ${errors.length} runtime errors`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser?.close();
  await sockets?.close();
  await new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });
  await runtime?.close();
  await db?.close();
  await rm(directory, { recursive: true, force: true });
}

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import express from 'express';
import { loadConfig } from './config.js';
import { createDatabase, migrate } from './db.js';
import { createApp } from './app.js';
import { BoardRuntime } from './boards/runtime.js';
import { attachBoardSockets } from './boards/socket.js';
import { assertPrivateStorage, createDevFileDeny } from './dev-policy.js';

const config = loadConfig();
const privateDirectories = [config.dataDir, config.boardDir ?? '.data/boards'];
assertPrivateStorage(privateDirectories);
const db = await createDatabase(config);
await migrate(db);
const boardRuntime = config.boardsEnabled
  ? await BoardRuntime.open(config.boardDir ?? '.data/boards')
  : undefined;
const { app, boardContext, processGoogleCalendar } = createApp(db, config, undefined, boardRuntime);
if (boardRuntime) {
  app.use(
    '/board-assets/5.6.0',
    express.static(resolve('node_modules/@tldraw/assets'), { maxAge: '1y', immutable: true }),
  );
}
const built = process.argv.includes('--built') || config.production;
let closeVite: (() => Promise<void>) | undefined;
if (!built) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    server: {
      middlewareMode: true,
      host: '127.0.0.1',
      ws: { host: '127.0.0.1', port: config.port + 1 },
      fs: { strict: true, deny: createDevFileDeny(privateDirectories) },
    },
    appType: 'custom',
  });
  closeVite = () => vite.close();
  app.use(vite.middlewares);
  app.use(async (req, res, next) => {
    if (req.method !== 'GET' || !req.accepts('html')) return next();
    try {
      res
        .type('html')
        .send(
          await vite.transformIndexHtml(
            req.originalUrl,
            await readFile(resolve('index.html'), 'utf8'),
          ),
        );
    } catch (error) {
      next(error);
    }
  });
} else {
  app.use(express.static(resolve('dist/client'), { index: false, maxAge: '1h' }));
  app.get('/{*splat}', (_req, res) => res.sendFile(resolve('dist/client/index.html')));
}
const server = app.listen(config.port, '127.0.0.1', () =>
  console.log(`TutorFlow: ${config.appUrl}${built ? ' (built)' : ''}`),
);
const boardSockets = attachBoardSockets(server, boardContext);
let stopping = false;
let calendarTask: Promise<unknown> | undefined;
const calendarTimer = processGoogleCalendar
  ? setInterval(() => {
      if (stopping || calendarTask) return;
      calendarTask = processGoogleCalendar()
        .catch(() => console.warn('Google Calendar synchronization was deferred.'))
        .finally(() => {
          calendarTask = undefined;
        });
    }, 2500)
  : undefined;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (calendarTimer) clearInterval(calendarTimer);
  await closeVite?.();
  await boardSockets.close();
  server.close(async () => {
    await calendarTask;
    await boardRuntime?.close();
    await db.close();
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

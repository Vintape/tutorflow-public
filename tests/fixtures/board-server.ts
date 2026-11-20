import { once } from 'node:events';
import { resolve, basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../../server/app.js';
import { createDatabase, migrate } from '../../server/db.js';
import { BoardRuntime } from '../../server/boards/runtime.js';
import { attachBoardSockets } from '../../server/boards/socket.js';
import type { Config } from '../../server/config.js';

// Dedicated crash-test process; never loads .env or inherited application database URLs.
const directory = resolve(process.env.TUTORFLOW_CRASH_TEST_DIR ?? '');
if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith('tutorflow-durable-'))
  throw new Error('Crash fixture requires its private synthetic temporary directory');
const config: Config = {
  production: false, port: 0, appUrl: 'http://localhost:3198',
  secret: 'synthetic-crash-only-secret-111111111111111111111111111',
  databaseSSL: false, dataDir: join(directory, 'crm'), aiModel: 'disabled', aiDailyLimit: 1,
  boardDir: join(directory, 'boards'), boardsEnabled: true,
};
const db = await createDatabase(config);
await migrate(db);
const runtime = await BoardRuntime.open(config.boardDir!);
const { app, boardContext } = createApp(db, config, undefined, runtime);
const server = app.listen(0, '127.0.0.1');
const sockets = attachBoardSockets(server, boardContext);
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No crash-test port');
process.send?.({ ready: true, port: address.port });
let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  await sockets.close();
  await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
  await runtime.close(); await db.close(); process.exit(0);
}
process.on('SIGTERM', () => { void close(); });
process.on('SIGINT', () => { void close(); });

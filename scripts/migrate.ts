import { loadConfig } from '../server/config.js';
import { createDatabase, migrate } from '../server/db.js';
const db = await createDatabase(loadConfig());
try {
  await migrate(db);
  console.log('Миграции применены.');
} finally {
  await db.close();
}

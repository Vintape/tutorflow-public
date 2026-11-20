import { loadConfig } from '../server/config.js';
import { createDatabase } from '../server/db.js';

const email = process.argv[2];
if (!email || !process.argv.includes('--confirm-delete-personal-data')) {
  console.error(
    'Остановите приложение, сделайте резервную копию. Использование: pnpm db:delete-account EMAIL --confirm-delete-personal-data',
  );
  process.exit(1);
}
const db = await createDatabase(loadConfig());
try {
  const removed = await db.query<{ id: string }>('DELETE FROM "user" WHERE email=$1 RETURNING id', [
    email,
  ]);
  console.log(
    removed.length
      ? 'Аккаунт, сессии и связанные персональные данные удалены.'
      : 'Аккаунт не найден.',
  );
} finally {
  await db.close();
}

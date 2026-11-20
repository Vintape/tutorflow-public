import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertBoardDiskBudget, purgeBoardFiles } from '../server/boards/disk.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'tutorflow-board-disk-')); dirs.push(dir); return dir; }
it('refuses aggregate growth before altering stored material', async () => {
  const dir = await directory(), path = join(dir, `${randomUUID()}.sqlite`);
  await writeFile(path, 'material');
  expect(() => assertBoardDiskBudget(dir, { additionalBytes: 5 }, { bytes: 10, reserveBytes: 0, transactionHeadroom: 0 })).toThrow();
  expect(await readFile(path, 'utf8')).toBe('material');
});
it('counts boards and WAL bytes, not just open rooms or main SQLite files', async () => {
  const dir = await directory();
  await writeFile(join(dir, `${randomUUID()}.sqlite`), 'a');
  const id = randomUUID(); await writeFile(join(dir, `${id}.sqlite`), 'b'); await writeFile(join(dir, `${id}.sqlite-wal`), 'W'.repeat(40));
  expect(() => assertBoardDiskBudget(dir, { newDocument: true }, { boards: 2, reserveBytes: 0, transactionHeadroom: 0 })).toThrow();
  expect(() => assertBoardDiskBudget(dir, {}, { bytes: 30, reserveBytes: 0, transactionHeadroom: 0 })).toThrow();
});
it('keeps free-space reserve for the filesystem shared with CRM', async () => {
  const dir = await directory();
  expect(() => assertBoardDiskBudget(dir, {}, { reserveBytes: Number.MAX_SAFE_INTEGER })).toThrow();
});
it('purges only the explicit board files and is retryable', async () => {
  const dir = await directory(), id = randomUUID(), other = randomUUID();
  for (const suffix of ['', '-wal', '-shm']) await writeFile(join(dir, `${id}.sqlite${suffix}`), 'owned');
  await writeFile(join(dir, `${other}.sqlite`), 'keep'); await writeFile(join(dir, 'unrelated.txt'), 'keep');
  purgeBoardFiles(dir, id); purgeBoardFiles(dir, id);
  await expect(access(join(dir, `${id}.sqlite`))).rejects.toThrow();
  expect(await readFile(join(dir, `${other}.sqlite`), 'utf8')).toBe('keep');
  expect(await readFile(join(dir, 'unrelated.txt'), 'utf8')).toBe('keep');
  expect(() => purgeBoardFiles(dir, '../outside')).toThrow();
});
it('refuses linked storage and never follows a symlink while purging', async () => {
  const dir = await directory(), targetDir = await directory(), id = randomUUID();
  const target = join(targetDir, 'material'); await writeFile(target, 'keep');
  await symlink(target, join(dir, `${id}.sqlite`));
  expect(() => assertBoardDiskBudget(dir)).toThrow();
  purgeBoardFiles(dir, id);
  expect(await readFile(target, 'utf8')).toBe('keep');
});

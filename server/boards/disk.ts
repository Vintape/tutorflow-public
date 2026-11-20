import { lstatSync, readdirSync, statfsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AppError } from '../errors.js';

// Local pilot ceilings, not a production capacity claim. Every write keeps a
// reserve on the shared filesystem; SQLite additionally caps each document.
export const BOARD_DISK_LIMITS = {
  boards: 200,
  bytes: 1024 * 1024 * 1024,
  reserveBytes: 256 * 1024 * 1024,
  transactionHeadroom: 32 * 1024 * 1024,
  sqliteBytes: 96 * 1024 * 1024,
};
type Limits = Partial<typeof BOARD_DISK_LIMITS>;
function reject(): never {
  throw new AppError(507, 'Недостаточно места для безопасного сохранения доски. Экспортируйте материалы и освободите место.', 'BOARD_STORAGE_LIMIT');
}
export function assertBoardDiskBudget(
  directory: string,
  operation: { newDocument?: boolean; additionalBytes?: number } = {},
  overrides: Limits = {},
) {
  const limits = { ...BOARD_DISK_LIMITS, ...overrides };
  const additional = operation.additionalBytes ?? 0;
  if (!Number.isSafeInteger(additional) || additional < 0) reject();
  let bytes = 0, boards = 0;
  for (const name of readdirSync(directory)) {
    const entry = lstatSync(join(directory, name));
    // Do not follow a local replacement into another project's files.
    if (entry.isSymbolicLink() || !entry.isFile() || !Number.isSafeInteger(entry.size)) reject();
    bytes += entry.size;
    if (/^[0-9a-f-]{36}\.sqlite$/i.test(name)) boards++;
  }
  if (bytes + additional + limits.transactionHeadroom > limits.bytes || (operation.newDocument && boards >= limits.boards)) reject();
  const space = statfsSync(directory, { bigint: true });
  if (space.bavail * space.bsize < BigInt(limits.reserveBytes + additional + limits.transactionHeadroom)) reject();
}

/** Call only after metadata tombstone, ordered operations and room close. */
export function purgeBoardFiles(directory: string, id: string) {
  z.uuid().parse(id);
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      // unlink never follows a symlink and never recursively removes directories.
      unlinkSync(join(directory, `${id}.sqlite${suffix}`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

import { afterAll, beforeAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, migrate } from '../server/db.js';
import { createColdBackup as backupFromProject, verifyColdBackup } from '../scripts/cold-backup.js';

let root: string;
let source: string;
const secret = 'synthetic-backup-secret-do-not-log-111111111111';

function createColdBackup(
  options: Omit<Parameters<typeof backupFromProject>[0], 'sourceProjectDir'> & {
    sourceProjectDir?: string;
  },
) {
  return backupFromProject({ sourceProjectDir: process.cwd(), ...options });
}
function killProcessGroup(pid: number | undefined) {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
async function runCli(args: string[], timeoutMs = 30000) {
  const child = spawn(
    'sh',
    ['scripts/tutorflow.sh', 'exec', 'tsx', 'scripts/cold-backup.ts', ...args],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessGroup(child.pid);
  }, timeoutMs);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.length > 1024 * 1024) killProcessGroup(child.pid);
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 1024 * 1024) killProcessGroup(child.pid);
  });
  try {
    return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0 && !timedOut) resolve({ stdout, stderr });
        else
          reject(
            Object.assign(new Error('Synthetic backup CLI failed'), {
              code: timedOut ? 'ETIMEDOUT' : code,
              stdout,
              stderr,
            }),
          );
      });
    });
  } finally {
    // Kill this test's private process group even after a timeout or assertion
    // failure, so a package runner cannot leave a child utility running.
    clearTimeout(timer);
    killProcessGroup(child.pid);
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tutorflow-cold-backup-test-'));
  source = join(root, 'source');
  const db = await createDatabase({ dataDir: source });
  try {
    await migrate(db);
    await db.query(
      `INSERT INTO "user" (id, name, email) VALUES ('owner', 'Synthetic tutor', 'backup@tutorflow.test')`,
    );
    await db.query(
      `INSERT INTO students (id, "ownerId", name, subject, price, duration, notes) VALUES ('student', 'owner', 'Synthetic student', 'Math', 125000, 60, 'Synthetic preserved note')`,
    );
    await db.query(
      `INSERT INTO lessons (id, "ownerId", "studentId", "startsAt", duration, price, status) VALUES ('lesson', 'owner', 'student', '2026-10-01T10:00:00Z', 60, 125000, 'COMPLETED')`,
    );
    await db.query(
      `INSERT INTO payments (id, "ownerId", "lessonId", amount, "paidAt") VALUES ('payment', 'owner', 'lesson', 125000, '2026-10-01T11:00:00Z')`,
    );
  } finally {
    await db.close();
  }
  await writeFile(join(root, 'auth-secret'), secret, { mode: 0o600 });
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function absent(path: string) {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function snapshot(path: string): Promise<string> {
  const entries: string[] = [];
  async function visit(dir: string, prefix: string) {
    for (const name of (await readdir(dir)).sort()) {
      const file = join(dir, name);
      const relative = `${prefix}${name}`;
      const stat = await lstat(file);
      if (stat.isDirectory()) {
        entries.push(`${relative}/`);
        await visit(file, `${relative}/`);
      } else {
        entries.push(
          `${relative}:${createHash('sha256')
            .update(await readFile(file))
            .digest('hex')}`,
        );
      }
    }
  }
  await visit(path, '');
  return entries.join('\n');
}

it('refuses the live server lock without making output or changing the source', async () => {
  const db = await createDatabase({ dataDir: source });
  const destination = join(root, 'locked-backup');
  try {
    const before = await snapshot(source);
    await expect(createColdBackup({ sourceDir: source, destination })).rejects.toMatchObject({
      code: 'ELOCKED',
    });
    expect(await snapshot(source)).toBe(before);
    await absent(destination);
    expect((await lstat(`${source}.lock`)).isDirectory()).toBe(true);
  } finally {
    await db.close();
  }
});

it('refuses stale locks instead of taking them over', async () => {
  const lock = `${source}.lock`;
  await mkdir(lock);
  await utimes(lock, new Date(0), new Date(0));
  try {
    await expect(
      createColdBackup({ sourceDir: source, destination: join(root, 'stale-backup') }),
    ).rejects.toMatchObject({ code: 'ELOCKED' });
    expect((await lstat(lock)).mtimeMs).toBe(0);
    await absent(join(root, 'stale-backup'));
  } finally {
    await rm(lock, { recursive: true });
  }
});

it('refuses a live PGlite marker even when another program did not acquire the server lock', async () => {
  const db = new PGlite(source);
  await db.waitReady;
  try {
    await expect(
      createColdBackup({ sourceDir: source, destination: join(root, 'unlocked-live-backup') }),
    ).rejects.toMatchObject({ code: 'ENOTCOLD' });
    await absent(join(root, 'unlocked-live-backup'));
    await absent(`${source}.lock`);
  } finally {
    await db.close();
  }
});

it('backs up cold synthetic rows and verifies only a new private restored copy', async () => {
  const before = await snapshot(source);
  const backup = join(root, 'cold-backup');
  const result = await createColdBackup({
    sourceDir: source,
    destination: backup,
    authSecretPath: join(root, 'auth-secret'),
  });
  expect(await snapshot(source)).toBe(before);
  expect(await snapshot(join(backup, 'data'))).toBe(before);
  expect((await lstat(backup)).mode & 0o777).toBe(0o700);
  expect((await lstat(join(backup, 'data'))).mode & 0o777).toBe(0o700);
  expect((await lstat(join(backup, 'auth-secret'))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(backup, 'auth-secret'), 'utf8')).toBe(secret);
  const manifest = await readFile(join(backup, 'manifest.json'), 'utf8');
  expect(manifest).not.toContain(secret);
  expect(result.manifestSha256).toBe(createHash('sha256').update(manifest).digest('hex'));
  const second = await createColdBackup({
    sourceDir: source,
    destination: join(root, 'cold-backup-2'),
    authSecretPath: join(root, 'auth-secret'),
  });
  expect(second.manifestSha256).toBe(result.manifestSha256);
  const backupBefore = await snapshot(backup);
  const restore = join(root, 'verified-restore');
  const report = await verifyColdBackup({
    backupDir: backup,
    destination: restore,
    expectedManifestSha256: result.manifestSha256,
  });
  expect(report.tables.find((table) => table.name === 'students')?.rows).toBe('1');
  expect(report.tables.find((table) => table.name === 'payments')?.rows).toBe('1');
  expect(report.totals).toEqual({
    completedLessonKopecks: '125000',
    activePaymentKopecks: '125000',
  });
  expect(report.schemaSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await snapshot(backup)).toBe(backupBefore);
  expect(await snapshot(source)).toBe(before);
  expect((await lstat(restore)).mode & 0o777).toBe(0o700);
  expect((await lstat(join(restore, 'auth-secret'))).mode & 0o777).toBe(0o600);
  const reopened = new PGlite(join(restore, 'data'));
  try {
    const rows = (
      await reopened.query<{ notes: string; amount: number }>(
        `SELECT students.notes, payments.amount FROM students JOIN payments ON payments."ownerId" = students."ownerId"`,
      )
    ).rows;
    expect(rows).toEqual([{ notes: 'Synthetic preserved note', amount: 125000 }]);
  } finally {
    await reopened.close();
  }
  await absent(`${source}.lock`);
  await absent(`${backup}.lock`);
  await absent(`${join(restore, 'data')}.lock`);
});

it('never overwrites an existing backup or restore destination', async () => {
  const backup = join(root, 'collision-backup');
  const result = await createColdBackup({ sourceDir: source, destination: backup });
  const before = await snapshot(backup);
  await expect(createColdBackup({ sourceDir: source, destination: backup })).rejects.toMatchObject({
    code: 'EEXIST',
  });
  expect(await snapshot(backup)).toBe(before);
  const restore = join(root, 'collision-restore');
  await mkdir(restore);
  await writeFile(join(restore, 'keep'), 'existing user file');
  await expect(
    verifyColdBackup({
      backupDir: backup,
      destination: restore,
      expectedManifestSha256: result.manifestSha256,
    }),
  ).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(join(restore, 'keep'), 'utf8')).toBe('existing user file');
});

it.each(['manifest', 'data', 'extra-file'] as const)(
  'rejects %s corruption before creating or opening any restored database',
  async (corruption) => {
    const backup = join(root, `corrupt-${corruption}`);
    const result = await createColdBackup({ sourceDir: source, destination: backup });
    if (corruption === 'manifest') await writeFile(join(backup, 'manifest.json'), '{}\n');
    if (corruption === 'data') await writeFile(join(backup, 'data', 'PG_VERSION'), 'corrupted\n');
    if (corruption === 'extra-file') await writeFile(join(backup, 'unexpected'), 'not in manifest');
    const destination = join(root, `corrupt-${corruption}-restore`);
    await expect(
      verifyColdBackup({
        backupDir: backup,
        destination,
        expectedManifestSha256: result.manifestSha256,
      }),
    ).rejects.toMatchObject({ code: 'EINTEGRITY' });
    await absent(destination);
  },
);

it('refuses verification with a different PGlite package version', async () => {
  const backup = join(root, 'version-backup');
  await createColdBackup({ sourceDir: source, destination: backup });
  const manifestPath = join(backup, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { pgliteVersion: string };
  manifest.pgliteVersion = '0.0.0';
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  const digest = createHash('sha256').update(content).digest('hex');
  await writeFile(manifestPath, content);
  await writeFile(join(backup, 'manifest.sha256'), `${digest}\n`);
  await expect(
    verifyColdBackup({
      backupDir: backup,
      destination: join(root, 'wrong-version-restore'),
      expectedManifestSha256: digest,
    }),
  ).rejects.toMatchObject({ code: 'EVERSION' });
  await absent(join(root, 'wrong-version-restore'));
});

it('refuses a source project with a different installed PGlite version before copying', async () => {
  const project = join(root, 'different-source-project');
  const installed = join(project, 'node_modules', '@electric-sql', 'pglite');
  await mkdir(installed, { recursive: true });
  await writeFile(join(project, 'package.json'), '{"name":"synthetic-source"}');
  await writeFile(
    join(installed, 'package.json'),
    '{"name":"@electric-sql/pglite","version":"0.0.0","main":"index.cjs"}',
  );
  await writeFile(join(installed, 'index.cjs'), '');
  const destination = join(root, 'source-version-mismatch');
  await expect(
    createColdBackup({ sourceDir: source, destination, sourceProjectDir: project }),
  ).rejects.toMatchObject({ code: 'EVERSION' });
  await absent(destination);
  await absent(`${source}.lock`);
});

it.each(['manifest.json', 'manifest.sha256'])(
  'refuses a %s symlink instead of reading outside the backup',
  async (filename) => {
    const backup = join(root, `${filename}-symlink-backup`);
    const result = await createColdBackup({ sourceDir: source, destination: backup });
    const manifestPath = join(backup, filename);
    const outside = join(root, `outside-${filename}`);
    await writeFile(outside, await readFile(manifestPath));
    await rm(manifestPath);
    await symlink(outside, manifestPath);
    const destination = join(root, `${filename}-symlink-restore`);
    await expect(
      verifyColdBackup({
        backupDir: backup,
        destination,
        expectedManifestSha256: result.manifestSha256,
      }),
    ).rejects.toMatchObject({ code: 'EINTEGRITY' });
    await absent(destination);
  },
);

it.each(['schema', 'payment'] as const)(
  'refuses a synthetic %s inconsistency with intact file checksums',
  async (problem) => {
    const broken = join(root, `broken-${problem}`);
    await cp(source, broken, { recursive: true });
    const db = await createDatabase({ dataDir: broken });
    try {
      if (problem === 'schema') await db.query('DROP TABLE pilot_events');
      else await db.query('UPDATE payments SET amount = 125001');
    } finally {
      await db.close();
    }
    const backup = join(root, `broken-${problem}-backup`);
    const result = await createColdBackup({ sourceDir: broken, destination: backup });
    const before = await snapshot(backup);
    const destination = join(root, `broken-${problem}-restore`);
    await expect(
      verifyColdBackup({
        backupDir: backup,
        destination,
        expectedManifestSha256: result.manifestSha256,
      }),
    ).rejects.toMatchObject({ code: 'EINTEGRITY' });
    await absent(destination);
    expect(await snapshot(backup)).toBe(before);
    await absent(`${backup}.lock`);
  },
);

it('rejects symlinks without copying files outside the selected source', async () => {
  const unsafe = join(root, 'symlink-source');
  await mkdir(unsafe);
  await writeFile(join(unsafe, 'PG_VERSION'), '18\n');
  await symlink(join(root, 'auth-secret'), join(unsafe, 'escaped-secret'));
  const destination = join(root, 'symlink-backup');
  await expect(createColdBackup({ sourceDir: unsafe, destination })).rejects.toMatchObject({
    code: 'EUNSAFE',
  });
  await absent(destination);
  expect(await readFile(join(root, 'auth-secret'), 'utf8')).toBe(secret);
});

it('keeps secret contents out of successful and failed command output', async () => {
  const destination = join(root, 'cli-backup');
  const { stdout, stderr } = await runCli([
    'backup',
    '--source',
    source,
    '--source-project',
    process.cwd(),
    '--destination',
    destination,
    '--auth-secret',
    join(root, 'auth-secret'),
  ]);
  expect(`${stdout}${stderr}`).not.toContain(secret);
  expect(JSON.parse(stdout)).toMatchObject({
    status: 'backup-created',
    manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  const error = (await runCli([
    'backup',
    '--source',
    source,
    '--source-project',
    process.cwd(),
    '--destination',
    join(root, 'cli-failure'),
    '--auth-secret',
    join(root, secret),
  ]).catch((value: unknown) => value)) as { stdout: string; stderr: string; code: number };
  expect(error.code).toBe(1);
  expect(`${error.stdout}${error.stderr}`).not.toContain(secret);
  await absent(join(root, 'cli-failure'));
});

it.each(['auth-secret', 'manifest.json', 'manifest.sha256'])(
  'refuses FIFO at %s promptly instead of waiting for a writer',
  async (filename) => {
    const backup = join(root, `fifo-${filename}-backup`);
    const result = await createColdBackup({ sourceDir: source, destination: backup });
    const pipe = join(backup, filename);
    if (filename !== 'auth-secret') await rm(pipe);
    execFileSync('mkfifo', [pipe], { timeout: 1000 });
    const destination = join(root, `fifo-${filename}-output`);
    // Backup uses its own cold copy so a timeout cannot strand a lock on
    // the common fixture used by the remaining tests.
    const args =
      filename === 'auth-secret'
        ? [
            'backup',
            '--source',
            join(backup, 'data'),
            '--source-project',
            process.cwd(),
            '--destination',
            destination,
            '--auth-secret',
            pipe,
          ]
        : [
            'verify',
            '--backup',
            backup,
            '--destination',
            destination,
            '--manifest-sha256',
            result.manifestSha256,
          ];
    const error = await runCli(args, 3000).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 1 });
    await absent(destination);
    await absent(filename === 'auth-secret' ? join(backup, 'data.lock') : `${backup}.lock`);
    expect((await lstat(pipe)).isFIFO()).toBe(true);
  },
);

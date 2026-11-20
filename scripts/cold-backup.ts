import { PGlite } from '@electric-sql/pglite';
import lockfile from 'proper-lockfile';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// This module deliberately does not import application configuration, DB helpers,
// migrations or credentials. PGlite is instantiated only on a new restore copy.
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const pathSchema = z
  .string()
  .refine(
    (path) =>
      (path === 'data' || path.startsWith('data/') || path === 'auth-secret') &&
      path
        .split('/')
        .every(
          (part) =>
            part !== '' &&
            part !== '.' &&
            part !== '..' &&
            !part.includes('\\') &&
            !part.includes('\0'),
        ),
  );
const entrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ path: pathSchema, kind: z.literal('directory') }),
  z.strictObject({
    path: pathSchema,
    kind: z.literal('file'),
    size: z.number().int().nonnegative().safe(),
    sha256: digestSchema,
  }),
]);
const manifestSchema = z.strictObject({
  format: z.literal('tutorflow-cold-backup'),
  version: z.literal(1),
  pgliteVersion: z.string().min(1),
  postgresMajor: z.string().regex(/^\d+$/),
  entries: z.array(entrySchema).min(1),
});
type Entry = z.infer<typeof entrySchema>;
type Manifest = z.infer<typeof manifestSchema>;
export interface VerificationReport {
  manifestSha256: string;
  tables: { name: string; rows: string }[];
  totals: { completedLessonKopecks: string; activePaymentKopecks: string };
  schemaSha256: string;
}
const encode = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const failure = (code: string) =>
  Object.assign(new Error(`Cold backup operation refused (${code})`), { code });
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false;
    throw error;
  }
}
async function directory(path: string) {
  if (!(await lstat(resolve(path))).isDirectory()) throw failure('EUNSAFE');
  return realpath(resolve(path));
}
async function destinationPath(path: string, source: string) {
  const destination = join(await realpath(dirname(resolve(path))), basename(resolve(path)));
  if (destination === source || destination.startsWith(`${source}${sep}`)) throw failure('EUNSAFE');
  if (await exists(destination)) throw failure('EEXIST');
  return destination;
}
async function privateDirectory(path: string) {
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
}
async function regularFile(path: string) {
  // A FIFO must not block open() before its non-regular type can be refused.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw failure('EUNSAFE');
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
async function readRegularText(path: string) {
  const file = await regularFile(path);
  try {
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}
async function hashFile(path: string) {
  const file = await regularFile(path);
  try {
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    return { size: (await file.stat()).size, sha256: hash.digest('hex') };
  } finally {
    await file.close();
  }
}
async function copyFile(source: string, destination: string) {
  const input = await regularFile(source);
  try {
    const output = await open(destination, 'wx', 0o600);
    try {
      await output.chmod(0o600);
      const buffer = Buffer.alloc(64 * 1024);
      while (true) {
        const { bytesRead } = await input.read(buffer);
        if (!bytesRead) break;
        let written = 0;
        while (written < bytesRead) {
          written += (await output.write(buffer, written, bytesRead - written)).bytesWritten;
        }
      }
      await output.sync();
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}
async function entriesAt(root: string, prefix = '', bundle = false): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const name of (await readdir(root)).sort()) {
    if (bundle && (name === 'manifest.json' || name === 'manifest.sha256')) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    const full = join(root, name);
    const stat = await lstat(full);
    if (stat.isDirectory()) {
      entries.push({ path, kind: 'directory' }, ...(await entriesAt(full, path)));
    } else if (stat.isFile()) {
      entries.push({ path, kind: 'file', ...(await hashFile(full)) });
    } else {
      throw failure('EUNSAFE');
    }
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
async function copyEntries(entries: Entry[], source: string, destination: string) {
  for (const entry of entries) {
    const to = join(destination, entry.path);
    if (entry.kind === 'directory') await privateDirectory(to);
    else await copyFile(join(source, entry.path), to);
  }
}
async function withExclusiveLock<T>(
  path: string,
  work: (check: () => void) => Promise<T>,
): Promise<T> {
  // Never recover/take over a stale lock. A stopped process or old lock requires
  // separate operator investigation, not automatic deletion by a backup tool.
  if (await exists(`${path}.lock`)) throw failure('ELOCKED');
  let compromised = false;
  const release = await lockfile.lock(path, {
    retries: 0,
    stale: Number.MAX_SAFE_INTEGER,
    update: 1000,
    onCompromised: () => {
      compromised = true;
    },
  });
  const check = () => {
    if (compromised) throw failure('ELOCKED');
  };
  try {
    const result = await work(check);
    check();
    return result;
  } finally {
    await release().catch((error: unknown) => {
      if (codeOf(error) !== 'ERELEASED') throw error;
    });
  }
}
async function packageVersion(anchor = import.meta.url) {
  const entry = createRequire(anchor).resolve('@electric-sql/pglite');
  for (const directory of [dirname(entry), dirname(dirname(entry))]) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
      };
      if (pkg.name === '@electric-sql/pglite') return z.string().min(1).parse(pkg.version);
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error;
    }
  }
  throw failure('EVERSION');
}
async function assertCold(source: string) {
  if (await exists(join(source, 'postmaster.pid'))) throw failure('ENOTCOLD');
}
async function postgresMajor(source: string) {
  const version = (await readRegularText(join(source, 'PG_VERSION'))).trim();
  if (!/^\d+$/.test(version)) throw failure('EINTEGRITY');
  return version;
}

export async function createColdBackup(options: {
  sourceDir: string;
  sourceProjectDir: string;
  destination: string;
  authSecretPath?: string;
}): Promise<{ manifestSha256: string }> {
  const pgliteVersion = await packageVersion();
  const sourceVersion = await packageVersion(
    join(await directory(options.sourceProjectDir), 'package.json'),
  );
  if (sourceVersion !== pgliteVersion) throw failure('EVERSION');
  const source = await directory(options.sourceDir);
  const destination = await destinationPath(options.destination, source);
  return withExclusiveLock(source, async (check) => {
    await assertCold(source);
    const entries: Entry[] = [
      { path: 'data', kind: 'directory' },
      ...(await entriesAt(source, 'data')),
    ];
    if (options.authSecretPath)
      entries.push({
        path: 'auth-secret',
        kind: 'file',
        ...(await hashFile(options.authSecretPath)),
      });
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const manifest: Manifest = {
      format: 'tutorflow-cold-backup',
      version: 1,
      pgliteVersion,
      postgresMajor: await postgresMajor(source),
      entries,
    };
    if (!entries.some((entry) => entry.path === 'data/global/pg_control' && entry.kind === 'file'))
      throw failure('EINTEGRITY');
    check();
    await privateDirectory(destination);
    try {
      await privateDirectory(join(destination, 'data'));
      for (const entry of entries) {
        if (entry.path === 'data') continue;
        const to = join(destination, entry.path);
        if (entry.kind === 'directory') await privateDirectory(to);
        else
          await copyFile(
            entry.path === 'auth-secret'
              ? options.authSecretPath!
              : join(source, entry.path.slice(5)),
            to,
          );
        check();
      }
      await assertCold(source);
      const after: Entry[] = [
        { path: 'data', kind: 'directory' },
        ...(await entriesAt(source, 'data')),
      ];
      if (options.authSecretPath)
        after.push({
          path: 'auth-secret',
          kind: 'file',
          ...(await hashFile(options.authSecretPath)),
        });
      after.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      if (
        encode(after) !== encode(entries) ||
        encode(await entriesAt(destination)) !== encode(entries)
      )
        throw failure('EINTEGRITY');
      check();
      const content = encode(manifest);
      const manifestSha256 = sha256(content);
      await writeFile(join(destination, 'manifest.json'), content, { flag: 'wx', mode: 0o600 });
      await writeFile(join(destination, 'manifest.sha256'), `${manifestSha256}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      check();
      return { manifestSha256 };
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  });
}

async function verifiedManifest(backup: string, expected: string): Promise<Manifest> {
  try {
    digestSchema.parse(expected);
    const raw = await readRegularText(join(backup, 'manifest.json'));
    const digest = (await readRegularText(join(backup, 'manifest.sha256'))).trim();
    if (sha256(raw) !== expected || digest !== expected) throw failure('EINTEGRITY');
    const manifest = manifestSchema.parse(JSON.parse(raw));
    if (
      raw !== encode(manifest) ||
      encode(await entriesAt(backup, '', true)) !== encode(manifest.entries)
    )
      throw failure('EINTEGRITY');
    await assertCold(join(backup, 'data'));
    if ((await postgresMajor(join(backup, 'data'))) !== manifest.postgresMajor)
      throw failure('EINTEGRITY');
    if (manifest.pgliteVersion !== (await packageVersion())) throw failure('EVERSION');
    return manifest;
  } catch (error) {
    if (codeOf(error) === 'EVERSION') throw error;
    throw failure('EINTEGRITY');
  }
}
async function inspectRestore(
  dataDir: string,
  manifest: Manifest,
): Promise<Omit<VerificationReport, 'manifestSha256'>> {
  const db = new PGlite(dataDir);
  try {
    await db.waitReady;
    await db.exec('BEGIN TRANSACTION READ ONLY');
    const version = (
      await db.query<{ major: string }>(
        `SELECT (current_setting('server_version_num')::int / 10000)::text AS major`,
      )
    ).rows[0].major;
    if (version !== manifest.postgresMajor) throw failure('EVERSION');
    const tableNames = (
      await db.query<{ name: string }>(
        `SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
      )
    ).rows;
    for (const required of [
      '_migrations',
      'user',
      'account',
      'session',
      'verification',
      'settings',
      'students',
      'lessons',
      'reports',
      'payments',
      'ai_usage',
      'pilot_events',
    ]) {
      if (!tableNames.some((table) => table.name === required)) throw failure('EINTEGRITY');
    }
    const schema = (
      await db.query(
        `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
      )
    ).rows;
    const constraints = (
      await db.query<{
        table_name: string;
        conname: string;
        definition: string;
        convalidated: boolean;
      }>(
        `SELECT c.relname AS table_name, p.conname, pg_get_constraintdef(p.oid) AS definition, p.convalidated FROM pg_catalog.pg_constraint p JOIN pg_catalog.pg_class c ON c.oid = p.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' ORDER BY c.relname, p.conname`,
      )
    ).rows;
    if (constraints.some((constraint) => constraint.convalidated !== true))
      throw failure('EINTEGRITY');
    const violations = (
      await db.query<{ count: string }>(`SELECT (
      (SELECT count(*) FROM students s LEFT JOIN "user" u ON u.id = s."ownerId" WHERE u.id IS NULL) +
      (SELECT count(*) FROM lessons l LEFT JOIN students s ON s.id = l."studentId" AND s."ownerId" = l."ownerId" WHERE s.id IS NULL) +
      (SELECT count(*) FROM reports r LEFT JOIN lessons l ON l.id = r."lessonId" AND l."ownerId" = r."ownerId" WHERE l.id IS NULL) +
      (SELECT count(*) FROM payments p LEFT JOIN lessons l ON l.id = p."lessonId" AND l."ownerId" = p."ownerId" WHERE l.id IS NULL OR (p."voidedAt" IS NULL AND (l.status <> 'COMPLETED' OR p.amount <> l.price)))
    )::text AS count`)
    ).rows[0].count;
    if (violations !== '0') throw failure('EINTEGRITY');
    const tables: { name: string; rows: string }[] = [];
    for (const { name } of tableNames) {
      const rows = (
        await db.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM public."${name.replaceAll('"', '""')}"`,
        )
      ).rows[0].count;
      tables.push({ name, rows });
    }
    const totals = (
      await db.query<{ completedLessonKopecks: string; activePaymentKopecks: string }>(
        `SELECT (SELECT coalesce(sum(price), 0)::text FROM lessons WHERE status = 'COMPLETED') AS "completedLessonKopecks", (SELECT coalesce(sum(amount), 0)::text FROM payments WHERE "voidedAt" IS NULL) AS "activePaymentKopecks"`,
      )
    ).rows[0];
    await db.exec('ROLLBACK');
    return { tables, totals, schemaSha256: sha256(encode({ schema, constraints })) };
  } catch (error) {
    if (codeOf(error) === 'EVERSION') throw error;
    throw failure('EINTEGRITY');
  } finally {
    await db.close();
  }
}

export async function verifyColdBackup(options: {
  backupDir: string;
  destination: string;
  expectedManifestSha256: string;
}): Promise<VerificationReport> {
  const backup = await directory(options.backupDir);
  const destination = await destinationPath(options.destination, backup);
  return withExclusiveLock(backup, async (check) => {
    const manifest = await verifiedManifest(backup, options.expectedManifestSha256);
    check();
    await privateDirectory(destination);
    try {
      await copyEntries(manifest.entries, backup, destination);
      if (encode(await entriesAt(destination)) !== encode(manifest.entries))
        throw failure('EINTEGRITY');
      await verifiedManifest(backup, options.expectedManifestSha256);
      check();
      const report = await withExclusiveLock(join(destination, 'data'), () =>
        inspectRestore(join(destination, 'data'), manifest),
      );
      check();
      return { manifestSha256: options.expectedManifestSha256, ...report };
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  });
}

async function main(args: string[]) {
  const [command, ...rest] = args;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (!flag?.startsWith('--') || !rest[i + 1] || flags[flag]) throw failure('EARGS');
    flags[flag] = rest[i + 1];
  }
  const allowed =
    command === 'backup'
      ? ['--source', '--source-project', '--destination', '--auth-secret']
      : ['--backup', '--destination', '--manifest-sha256'];
  if (
    !['backup', 'verify'].includes(command) ||
    Object.keys(flags).some((flag) => !allowed.includes(flag)) ||
    !flags['--destination']
  )
    throw failure('EARGS');
  if (command === 'backup' && flags['--source'] && flags['--source-project']) {
    const result = await createColdBackup({
      sourceDir: flags['--source'],
      sourceProjectDir: flags['--source-project'],
      destination: flags['--destination'],
      authSecretPath: flags['--auth-secret'],
    });
    console.log(JSON.stringify({ status: 'backup-created', ...result }));
  } else if (command === 'verify' && flags['--backup'] && flags['--manifest-sha256']) {
    const report = await verifyColdBackup({
      backupDir: flags['--backup'],
      destination: flags['--destination'],
      expectedManifestSha256: flags['--manifest-sha256'],
    });
    console.log(JSON.stringify({ status: 'restore-verified', ...report }));
  } else {
    throw failure('EARGS');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    // Never echo arguments, source paths, raw filesystem/SQL errors or secrets.
    const code = codeOf(error);
    console.error(
      JSON.stringify({ status: 'refused', code: code && /^[A-Z]+$/.test(code) ? code : 'EFAILED' }),
    );
    process.exitCode = 1;
  });
}

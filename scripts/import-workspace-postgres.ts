import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readFile, realpath, rm } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { parseEnv, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createDatabase, type Database, type SQL } from '../server/db.js';
import {
  CALENDAR_TABLES_BY_MIGRATION,
  verifyWorkspaceBackup,
  type WorkspaceRestoreResult,
} from './workspace-backup.js';

// Fixed dependency order from the checked-in migrations. SQLite canvas/history
// stays in the restored workspace; only the CRM and its board references move.
const TABLES_BY_MIGRATION = {
  '0001_initial.sql': [
    '_migrations',
    'user',
    'session',
    'account',
    'verification',
    'settings',
    'students',
    'lessons',
    'reports',
    'payments',
    'ai_usage',
    'pilot_events',
  ],
  '0002_boards.sql': [
    'boards',
    'board_students',
    'board_lessons',
    'board_invitations',
    'board_guest_sessions',
  ],
  ...CALENDAR_TABLES_BY_MIGRATION,
} as const;
type MigrationName = keyof typeof TABLES_BY_MIGRATION;
type Table = (typeof TABLES_BY_MIGRATION)[MigrationName][number];
type BaseTable = (typeof TABLES_BY_MIGRATION)['0001_initial.sql' | '0002_boards.sql'][number];
type CalendarTable = Exclude<Table, BaseTable>;
type Row = Record<string, unknown>;
type Column = { name: string; type: string; nullable: string };
export interface ImportTarget {
  host: string;
  port: number;
  database: string;
  role: string;
  connectionUsername: string;
}
interface TableProof {
  count: number;
  sha256: string;
}
interface FinanceProof {
  payments: number;
  activePayments: number;
  receivedKopecks: string;
  completedLessons: number;
  accruedKopecks: string;
}
export interface ImportResult {
  restoredWorkspace: string;
  manifestSha256: string;
  tables: Record<BaseTable, TableProof> & Partial<Record<CalendarTable, TableProof>>;
  finance: FinanceProof;
}
const fail = (code: string) =>
  Object.assign(new Error(`Workspace import refused (${code})`), { code });
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
const isJson = (type: string) => type === 'json' || type === 'jsonb';
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
const proof = (rows: Row[]): TableProof => ({
  count: rows.length,
  sha256: createHash('sha256')
    .update(canonical(rows.map(canonical).sort()))
    .digest('hex'),
});

export function validateImportTarget(value: string, expected: ImportTarget): string {
  try {
    const url = new URL(value);
    const local = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.password ||
      url.hash ||
      url.hostname !== expected.host ||
      Number(url.port || 5432) !== expected.port ||
      decodeURIComponent(url.pathname.slice(1)) !== expected.database ||
      decodeURIComponent(url.username) !== expected.connectionUsername ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(expected.role) ||
      new Set(url.searchParams.keys()).size !== [...url.searchParams.keys()].length ||
      [...url.searchParams.keys()].some((key) => !['sslmode', 'sslrootcert'].includes(key)) ||
      (local
        ? !/^tutorflow_pg_harness_import_[a-f0-9]{32}$/.test(expected.database) ||
          !/^tutorflow_import_[a-f0-9]{32}$/.test(expected.role) ||
          (!!url.search && url.searchParams.get('sslmode') !== 'disable')
        : url.searchParams.get('sslmode') !== 'verify-full')
    )
      throw fail('ETARGET');
    return url.toString();
  } catch {
    throw fail('ETARGET');
  }
}
// The URI parser in pg can replace the explicit SSL configuration. Strip its
// SSL parameters first, then provide TLS options that cannot inherit an unsafe
// NODE_TLS_REJECT_UNAUTHORIZED setting.
export async function buildImportClientConfig(connectionString: string): Promise<pg.ClientConfig> {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw fail('ETLS');
  const url = new URL(connectionString);
  const local = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  const caPath = url.searchParams.get('sslrootcert');
  let ca: string | undefined;
  if (caPath) {
    const handle = await open(
      caPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1048576) throw fail('ETLS');
      ca = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  }
  url.searchParams.delete('sslmode');
  url.searchParams.delete('sslrootcert');
  return {
    connectionString: url.toString(),
    ssl: local ? false : { rejectUnauthorized: true, ...(ca === undefined ? {} : { ca }) },
  };
}
async function connectionFromFile(path: string, expected: ImportTarget) {
  const filePath = resolve(path),
    repo = await realpath(process.cwd());
  const rel = relative(repo, filePath);
  if (rel.startsWith(`..${sep}`) || rel === '..' || !rel || (await realpath(filePath)) !== filePath)
    throw fail('EENV');
  try {
    await promisify(execFile)('git', ['check-ignore', '--quiet', '--', rel], { cwd: repo });
  } catch {
    throw fail('EENV');
  }
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 65536) throw fail('EENV');
    const env = parseEnv(await handle.readFile('utf8'));
    if (!env.DATABASE_URL) throw fail('EENV');
    return validateImportTarget(env.DATABASE_URL, expected);
  } finally {
    await handle.close();
  }
}
async function columns(sql: SQL, table: Table) {
  return sql.query<Column>(
    `SELECT column_name AS name,udt_name AS type,is_nullable AS nullable FROM information_schema.columns
     WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position`,
    [table],
  );
}
async function rows(sql: SQL, table: Table, definitions: Column[]): Promise<Row[]> {
  // SQL JSON preserves timestamp microseconds; JS Date would silently round them.
  // Omit SQL NULL JSON columns so literal JSON null stays distinct in row proofs.
  const nullableJson = definitions
    .filter(({ type, nullable }) => isJson(type) && nullable === 'YES')
    .map(({ name }) => name);
  let document = 'to_jsonb(t)';
  if (nullableJson.length) {
    const sqlNulls = nullableJson.map(
      (name, index) => `CASE WHEN t.${quoted(name)} IS NULL THEN $${index + 1}::text END`,
    );
    document += ` - array_remove(ARRAY[${sqlNulls.join(', ')}], NULL)`;
  }
  return (
    await sql.query<{ value: string }>(
      `SELECT (${document})::text AS value FROM ${quoted(table)} t`,
      nullableJson,
    )
  ).map(
    (row) =>
      JSON.parse(row.value, (_key: string, value: unknown) => {
        if (typeof value === 'number' && !Number.isSafeInteger(value)) throw fail('ESOURCE_NUMBER');
        return value;
      }) as Row,
  );
}
async function finance(sql: SQL): Promise<FinanceProof> {
  const [result] = await sql.query<FinanceProof>(`SELECT
    (SELECT count(*)::integer FROM payments) AS payments,
    (SELECT count(*)::integer FROM payments WHERE "voidedAt" IS NULL) AS "activePayments",
    (SELECT COALESCE(sum(amount),0)::text FROM payments WHERE "voidedAt" IS NULL) AS "receivedKopecks",
    (SELECT count(*)::integer FROM lessons WHERE status='COMPLETED') AS "completedLessons",
    (SELECT COALESCE(sum(price),0)::text FROM lessons WHERE status='COMPLETED') AS "accruedKopecks"`);
  return result;
}
async function targetGuard(sql: SQL, expected: ImportTarget) {
  const [identity] = await sql.query<{
    role: string;
    database: string;
    schema: string;
    paths: string[];
    searchPath: string;
    superuser: boolean;
    bypass: boolean;
  }>(
    `SELECT current_user AS role,current_database() AS database,current_schema() AS schema,
     current_schemas(false)::text[] AS paths,current_setting('search_path') AS "searchPath",rolsuper AS superuser,rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user`,
  );
  if (
    !identity ||
    identity.role !== expected.role ||
    identity.database !== expected.database ||
    identity.schema !== 'tutorflow' ||
    !['tutorflow', 'tutorflow,pg_catalog'].includes(identity.searchPath.replace(/\s/g, '')) ||
    canonical(identity.paths.filter((path) => path !== 'pg_catalog')) !==
      canonical(['tutorflow']) ||
    identity.superuser ||
    identity.bypass
  )
    throw fail('ETARGET');
  const [existing] = await sql.query<{ count: number }>(
    `SELECT ((SELECT count(*) FROM pg_class WHERE relnamespace='tutorflow'::regnamespace) +
      (SELECT count(*) FROM pg_proc WHERE pronamespace='tutorflow'::regnamespace) +
      (SELECT count(*) FROM pg_type WHERE typnamespace='tutorflow'::regnamespace))::integer AS count`,
  );
  if (existing.count !== 0) throw fail('ETARGET_NOT_EMPTY');
  const exposed = await sql.query(`SELECT 1 FROM pg_namespace n WHERE n.nspname='tutorflow' AND
    (EXISTS (SELECT 1 FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE a.grantee=0 AND a.privilege_type IN ('USAGE','CREATE')) OR EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role') AND has_schema_privilege(r.oid,n.oid,'USAGE'))) `);
  if (exposed.length) throw fail('ETARGET_EXPOSED');
}
async function migrateArchivedSchema(sql: SQL, migrations: WorkspaceRestoreResult['migrations']) {
  await sql.query(
    'CREATE TABLE _migrations (name text PRIMARY KEY, hash text NOT NULL, "appliedAt" timestamptz NOT NULL DEFAULT now())',
  );
  for (const { name, hash } of migrations) {
    const body = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    if (createHash('sha256').update(body).digest('hex') !== hash) throw fail('EMIGRATIONS');
    for (const statement of body.split('-- statement-breakpoint'))
      if (statement.trim()) await sql.query(statement);
    await sql.query('INSERT INTO _migrations (name, hash) VALUES ($1, $2)', [name, hash]);
  }
}

export async function importWorkspacePostgres(options: {
  archiveDir: string;
  expectedManifestSha256: string;
  restoredDir: string;
  targetEnvFile: string;
  expectedTarget: ImportTarget;
}): Promise<ImportResult> {
  let source: Database | undefined,
    client: pg.Client | undefined,
    restored = false,
    commitAttempted = false;
  try {
    const connectionString = await connectionFromFile(
      options.targetEnvFile,
      options.expectedTarget,
    );
    // Only verifyWorkspaceBackup may create/open a workspace: its fresh copy is
    // validated against the trusted manifest and archived bearer access revoked.
    const restore = await verifyWorkspaceBackup({
      archiveDir: options.archiveDir,
      destination: options.restoredDir,
      expectedManifestSha256: options.expectedManifestSha256,
    });
    restored = true;
    const importTables = restore.migrations.flatMap(({ name }) => {
      if (!Object.hasOwn(TABLES_BY_MIGRATION, name)) throw fail('EMIGRATIONS');
      return TABLES_BY_MIGRATION[name as MigrationName];
    });
    source = await createDatabase({ dataDir: resolve(options.restoredDir, 'crm') });
    const snapshot = await source.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await tx.query("SET LOCAL TIME ZONE 'UTC'");
      const actual = await tx.query<{ name: string }>(
        'SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename',
      );
      if (canonical(actual.map((t) => t.name).sort()) !== canonical([...importTables].sort()))
        throw fail('ESOURCE_SCHEMA');
      const tables = {} as Record<Table, Row[]>,
        definitions = {} as Record<Table, Column[]>;
      for (const table of importTables) {
        definitions[table] = await columns(tx, table);
        tables[table] = await rows(tx, table, definitions[table]);
      }
      if (
        tables.session.length ||
        tables.board_invitations.some((row) => row.revokedAt === null) ||
        tables.board_guest_sessions.some((row) => row.revokedAt === null)
      )
        throw fail('ESOURCE_SESSIONS');
      if (
        tables.google_calendar_oauth_states?.length ||
        tables.google_calendar_connections?.some(
          (row) =>
            row.refreshCiphertext !== null ||
            row.status !== 'disconnected' ||
            row.canReadBusy !== false ||
            row.calendarClaim !== null,
        )
      )
        throw fail('ESOURCE_CALENDAR');
      return { tables, definitions, finance: await finance(tx) };
    });
    await source.close();
    source = undefined;
    // A single bounded client owns BEGIN/migrate/import/verification/COMMIT.
    client = new pg.Client({
      ...(await buildImportClientConfig(connectionString)),
      connectionTimeoutMillis: 10000,
      query_timeout: 60000,
      statement_timeout: 60000,
      lock_timeout: 10000,
      application_name: 'tutorflow-workspace-import',
    });
    client.on('error', () => {
      /* CLI only reports sanitized refusal codes. */
    });
    await client.connect();
    const sql: SQL = {
      query: async <T>(text: string, values: unknown[] = []) =>
        (await client!.query(text, values)).rows as T[],
    };
    await sql.query('BEGIN');
    try {
      await sql.query("SET LOCAL TIME ZONE 'UTC'");
      await sql.query("SET LOCAL idle_in_transaction_session_timeout='60s'");
      await sql.query("SELECT pg_advisory_xact_lock(hashtext('tutorflow-workspace-import'))");
      await targetGuard(sql, options.expectedTarget);
      await migrateArchivedSchema(sql, restore.migrations);
      for (const table of importTables) {
        if (canonical(await columns(sql, table)) !== canonical(snapshot.definitions[table]))
          throw fail('ECOLUMNS');
        if (table === '_migrations') {
          const applied = await sql.query('SELECT name,hash FROM _migrations ORDER BY name');
          if (canonical(applied) !== canonical(restore.migrations)) throw fail('EMIGRATIONS');
          for (const row of snapshot.tables._migrations)
            await sql.query('UPDATE _migrations SET "appliedAt"=$1 WHERE name=$2', [
              row.appliedAt,
              row.name,
            ]);
          continue;
        }
        const names = snapshot.definitions[table].map((c) => c.name);
        const statement = `INSERT INTO ${quoted(table)} (${names.map(quoted).join(',')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(',')})`;
        for (const row of snapshot.tables[table])
          await sql.query(
            statement,
            snapshot.definitions[table].map(({ name, type }) => {
              const value = row[name];
              return isJson(type) && value !== undefined ? JSON.stringify(value) : (value ?? null);
            }),
          );
      }
      await sql.query('SET CONSTRAINTS ALL IMMEDIATE');
      const tables = {} as ImportResult['tables'];
      for (const table of importTables) {
        tables[table] = proof(await rows(sql, table, snapshot.definitions[table]));
        if (canonical(tables[table]) !== canonical(proof(snapshot.tables[table])))
          throw fail('EROWS');
      }
      const actualFinance = await finance(sql);
      if (canonical(actualFinance) !== canonical(snapshot.finance)) throw fail('EFINANCE');
      commitAttempted = true;
      await sql.query('COMMIT');
      return {
        restoredWorkspace: resolve(options.restoredDir),
        manifestSha256: restore.manifestSha256,
        tables,
        finance: actualFinance,
      };
    } catch (error) {
      if (commitAttempted) throw fail('ECOMMIT_UNCERTAIN');
      await sql.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    await source?.close();
    source = undefined;
    if (restored && !commitAttempted)
      await rm(options.restoredDir, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException)?.code;
    throw fail(
      code && /^E[A-Z_]+$/.test(code)
        ? code
        : code && /^[A-Z0-9]{5}$/.test(code)
          ? `EPG_${code}`
          : 'EFAILED',
    );
  } finally {
    await source?.close();
    await client?.end();
  }
}
async function main(args: string[]) {
  const allowed = [
    '--archive',
    '--manifest-sha256',
    '--restored',
    '--target-env',
    '--host',
    '--port',
    '--database',
    '--role',
    '--connection-user',
  ];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || !args[i + 1] || flags[args[i]]) throw fail('EARGS');
    flags[args[i]] = args[i + 1];
  }
  if (allowed.some((flag) => !flags[flag]) || !/^\d+$/.test(flags['--port'])) throw fail('EARGS');
  const result = await importWorkspacePostgres({
    archiveDir: flags['--archive'],
    expectedManifestSha256: flags['--manifest-sha256'],
    restoredDir: flags['--restored'],
    targetEnvFile: flags['--target-env'],
    expectedTarget: {
      host: flags['--host'],
      port: Number(flags['--port']),
      database: flags['--database'],
      role: flags['--role'],
      connectionUsername: flags['--connection-user'],
    },
  });
  console.log(
    JSON.stringify({
      status: 'workspace-postgres-imported',
      restoredWorkspace: result.restoredWorkspace,
      manifestSha256: result.manifestSha256,
      tables: result.tables,
      financeVerified: true,
    }),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException)?.code;
    console.error(
      JSON.stringify({
        status: 'refused',
        code: code && /^E[A-Z_]+$/.test(code) ? code : 'EFAILED',
      }),
    );
    process.exitCode = 1;
  });
}

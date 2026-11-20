import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzleLite } from 'drizzle-orm/pglite';
import { drizzle as drizzlePG } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import lockfile from 'proper-lockfile';
import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import * as schema from './schema.js';

export interface SQL {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}
export interface Database extends SQL {
  orm: ReturnType<typeof drizzleLite<typeof schema>> | ReturnType<typeof drizzlePG<typeof schema>>;
  transaction<T>(fn: (tx: SQL) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
function normalize<T>(rows: unknown[]): T[] {
  return JSON.parse(
    JSON.stringify(rows, (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isSafeInteger(value))
        throw new Error('Database numeric value exceeds the exact integer range');
      return value;
    }),
  ) as T[];
}

// pg URI SSL parameters otherwise replace an explicit ssl object. Build the
// final verified settings only after removing those parser overrides.
export async function postgresPoolConfig(
  connectionString: string,
  verifiedTLS: boolean,
  relayPort?: number,
): Promise<pg.PoolConfig> {
  const refused = () => new Error('Verified PostgreSQL TLS configuration refused');
  if (!verifiedTLS) {
    if (relayPort !== undefined) throw refused();
    return { connectionString };
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw refused();
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw refused();
  }
  const sslKeys = [...url.searchParams.keys()].filter(
    (key) => key.startsWith('ssl') || key === 'uselibpqcompat',
  );
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    new Set(sslKeys).size !== sslKeys.length ||
    sslKeys.some((key) => !['sslmode', 'sslrootcert'].includes(key)) ||
    (url.searchParams.has('sslmode') && url.searchParams.get('sslmode') !== 'verify-full')
  )
    throw refused();
  const relayServerName = relayPort === undefined ? undefined : url.hostname;
  if (
    relayPort !== undefined &&
    (!Number.isInteger(relayPort) ||
      relayPort < 1 ||
      relayPort > 65535 ||
      isIP(url.hostname) !== 0 ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
        url.hostname,
      ) ||
      [...url.searchParams.keys()].some((key) => !['sslmode', 'sslrootcert'].includes(key)))
  )
    throw refused();
  const caPath = url.searchParams.get('sslrootcert');
  let ca: string | undefined;
  if (caPath) {
    try {
      const handle = await open(
        caPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 1048576) throw refused();
        ca = await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    } catch {
      throw refused();
    }
  }
  url.searchParams.delete('sslmode');
  url.searchParams.delete('sslrootcert');
  if (relayPort !== undefined) {
    // Only the TCP destination changes. TLS still authenticates the URI's original DNS name.
    url.hostname = '127.0.0.1';
    url.port = String(relayPort);
  }
  return {
    connectionString: url.toString(),
    ssl: {
      rejectUnauthorized: true,
      ...(ca === undefined ? {} : { ca }),
      ...(relayServerName === undefined ? {} : { servername: relayServerName }),
    },
    ...(relayPort === undefined ? {} : { connectionTimeoutMillis: 10_000 }),
  };
}

export async function createDatabase(options: {
  databaseUrl?: string;
  dataDir: string;
  databaseSSL?: boolean;
  databaseRelayPort?: number;
}): Promise<Database> {
  if (!options.databaseUrl && options.databaseRelayPort !== undefined)
    throw new Error('PostgreSQL loopback relay requires DATABASE_URL');
  if (options.databaseUrl) {
    const pool = new pg.Pool({
      ...(await postgresPoolConfig(
        options.databaseUrl,
        options.databaseSSL ?? false,
        options.databaseRelayPort,
      )),
      max: 8,
    });
    pool.on('error', () => {
      console.warn('An idle PostgreSQL connection was closed.');
    });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      await pool.end();
      throw error;
    }
    return {
      orm: drizzlePG(pool, { schema }),
      query: async <T>(sql: string, params: unknown[] = []) =>
        normalize<T>((await pool.query(sql, params)).rows),
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn({
            query: async <T>(sql: string, params: unknown[] = []) =>
              normalize<T>((await client.query(sql, params)).rows),
          });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  if (options.dataDir !== 'memory://')
    await mkdir(resolve(options.dataDir), { recursive: true, mode: 0o700 });
  const release =
    options.dataDir === 'memory://'
      ? undefined
      : await lockfile.lock(resolve(options.dataDir), { retries: 0, stale: 10000 });
  let lite: PGlite;
  try {
    lite = new PGlite(options.dataDir);
    await lite.waitReady;
  } catch (error) {
    await release?.();
    throw error;
  }
  return {
    orm: drizzleLite(lite, { schema }),
    query: async <T>(sql: string, params: unknown[] = []) =>
      normalize<T>((await lite.query(sql, params)).rows),
    transaction: (fn) =>
      lite.transaction((tx) =>
        fn({
          query: async <T>(sql: string, params: unknown[] = []) =>
            normalize<T>((await tx.query(sql, params)).rows),
        }),
      ),
    close: async () => {
      try {
        await lite.close();
      } finally {
        await release?.();
      }
    },
  };
}
export async function migrate(db: Database): Promise<void> {
  await db.query(
    'CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, hash text NOT NULL, "appliedAt" timestamptz NOT NULL DEFAULT now())',
  );
  const files = (await readdir(resolve('migrations'))).filter((f) => f.endsWith('.sql')).sort();
  for (const name of files) {
    const sql = await readFile(resolve('migrations', name), 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    const [existing] = await db.query<{ hash: string }>(
      'SELECT hash FROM _migrations WHERE name = $1',
      [name],
    );
    if (existing) {
      if (existing.hash !== hash) throw new Error(`Applied migration was modified: ${name}`);
      continue;
    }
    await db.transaction(async (tx) => {
      // Migration files are trusted checked-in SQL; never execute user input here.
      for (const statement of sql.split('-- statement-breakpoint'))
        if (statement.trim()) await tx.query(statement);
      await tx.query('INSERT INTO _migrations (name, hash) VALUES ($1, $2)', [name, hash]);
    });
  }
}

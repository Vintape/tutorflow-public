import { afterEach, expect, it, vi } from 'vitest';
import pg from 'pg';
import { postgresPoolConfig } from '../server/db.js';

afterEach(() => vi.unstubAllEnvs());
it('makes the final pg Pool reject unverified TLS even when URI SSL options are parsed', async () => {
  const config = await postgresPoolConfig(
    'postgresql://synthetic:synthetic@db.example/postgres?sslmode=verify-full',
    true,
  );
  const pool = new pg.Pool(config);
  try {
    expect(pool.options.ssl).toMatchObject({ rejectUnauthorized: true });
    expect(config.connectionString).not.toContain('sslmode=');
  } finally {
    await pool.end();
  }
});
it('refuses ambient TLS bypass and insecure URI overrides without exposing credentials', async () => {
  vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
  await expect(
    postgresPoolConfig('postgresql://synthetic:private-value@db.example/postgres', true),
  ).rejects.toThrow('Verified PostgreSQL TLS');
  vi.unstubAllEnvs();
  for (const suffix of [
    'sslmode=disable',
    'sslmode=no-verify',
    'sslmode=verify-full&sslmode=disable',
    'ssl=false',
    'uselibpqcompat=true',
  ]) {
    await expect(
      postgresPoolConfig(
        `postgresql://synthetic:private-value@db.example/postgres?${suffix}`,
        true,
      ),
    ).rejects.toThrow('Verified PostgreSQL TLS');
  }
});
it('preserves explicit non-SSL synthetic harness configuration', async () => {
  const uri = 'postgresql://synthetic:synthetic@127.0.0.1:5432/tutorflow_pg_harness_test';
  expect(await postgresPoolConfig(uri, false)).toEqual({ connectionString: uri });
});

it('connects pg to the selected loopback port while verifying the original PostgreSQL host', async () => {
  const config = await postgresPoolConfig(
    'postgresql://synthetic:synthetic@db.example:5432/postgres?sslmode=verify-full',
    true,
    15432,
  );
  const client = new pg.Client(config);
  expect(client.host).toBe('127.0.0.1');
  expect(client.port).toBe(15432);
  expect(client.ssl).toMatchObject({ rejectUnauthorized: true, servername: 'db.example' });
});

it('rejects unverified, ambiguous or invalid relay configuration', async () => {
  const uri = 'postgresql://synthetic:private-value@db.example:5432/postgres';
  for (const [target, verifiedTLS, port] of [
    [uri, false, 15432],
    [uri, true, 0],
    [uri, true, 65536],
    [uri, true, 15432.5],
    [uri + '?host=other.example', true, 15432],
    [uri + '?port=5432', true, 15432],
    ['postgresql://synthetic:private-value@127.0.0.1/postgres', true, 15432],
    ['postgresql://synthetic:private-value@invalid_host/postgres', true, 15432],
  ] as const) {
    await expect(postgresPoolConfig(target, verifiedTLS, port)).rejects.toThrow(
      'Verified PostgreSQL TLS',
    );
  }
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';

export interface Config {
  production: boolean;
  port: number;
  appUrl: string;
  secret: string;
  databaseUrl?: string;
  databaseSSL: boolean;
  databaseRelayPort?: number;
  dataDir: string;
  aiKey?: string;
  aiModel: string;
  aiDailyLimit: number;
  boardDir?: string;
  boardLicenseKey?: string;
  boardsEnabled?: boolean;
  googleCalendar?: { clientId: string; clientSecret: string; encryptionKey: string };
}
export function loadConfig(): Config {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const production = process.env.NODE_ENV === 'production';
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(process.env.PORT || '3000');
  const appUrl = z.url().parse(process.env.APP_URL || `http://localhost:${port}`);
  const relayPort = process.env.DATABASE_RELAY_PORT;
  const googleClientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const googleEncryptionKey = process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY;
  if (
    production &&
    (!process.env.BETTER_AUTH_SECRET || !process.env.DATABASE_URL || !appUrl.startsWith('https://'))
  ) {
    throw new Error('Production requires BETTER_AUTH_SECRET, DATABASE_URL and an HTTPS APP_URL');
  }
  let secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    mkdirSync('.data', { recursive: true, mode: 0o700 });
    const file = resolve('.data/auth-secret');
    if (!existsSync(file))
      writeFileSync(file, randomBytes(48).toString('hex'), { mode: 0o600, flag: 'wx' });
    secret = readFileSync(file, 'utf8').trim();
  }
  if (secret.length < 32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  return {
    production,
    port,
    appUrl: new URL(appUrl).origin,
    secret,
    databaseUrl: process.env.DATABASE_URL || undefined,
    databaseSSL: process.env.DATABASE_SSL === 'true',
    databaseRelayPort: relayPort
      ? z
          .string()
          .regex(/^\d{1,5}$/)
          .pipe(z.coerce.number<string>().int().min(1).max(65535))
          .parse(relayPort)
      : undefined,
    dataDir: process.env.PGLITE_DIR || '.data/postgres',
    aiKey: process.env.OPENAI_API_KEY || undefined,
    aiModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    aiDailyLimit: z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .parse(process.env.AI_DAILY_LIMIT || '20'),
    boardDir: process.env.BOARD_DIR || '.data/boards',
    boardLicenseKey: process.env.TLDRAW_LICENSE_KEY || undefined,
    boardsEnabled: !production || Boolean(process.env.TLDRAW_LICENSE_KEY),
    googleCalendar:
      googleClientId &&
      googleClientSecret &&
      googleEncryptionKey &&
      /^[a-fA-F0-9]{64}$/.test(googleEncryptionKey)
        ? {
            clientId: googleClientId,
            clientSecret: googleClientSecret,
            encryptionKey: googleEncryptionKey,
          }
        : undefined,
  };
}

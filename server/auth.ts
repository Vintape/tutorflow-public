import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { Config } from './config.js';
import type { Database } from './db.js';
import * as schema from './schema.js';

export function createAuth(db: Database, config: Config) {
  return betterAuth({
    appName: 'TutorFlow',
    baseURL: config.appUrl,
    secret: config.secret,
    trustedOrigins: [config.appUrl],
    database: drizzleAdapter(db.orm, { provider: 'pg', schema, transaction: true }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      requireEmailVerification: false,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 80,
      storage: 'memory',
      customRules: {
        '/sign-in/email': { window: 60, max: 8 },
        '/sign-up/email': { window: 60, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: config.production,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
    },
    logger: { disabled: true },
  });
}

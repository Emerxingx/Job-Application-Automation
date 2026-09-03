#!/usr/bin/env node
/**
 * Run a command with DATABASE_URL and DIRECT_URL percent-encoded.
 *
 *   node scripts/db/with-encoded-env.mjs prisma migrate deploy
 *
 * The application normalises its own connection string (src/lib/db-url.ts),
 * but the Prisma CLI reads `directUrl = env("DIRECT_URL")` raw from the
 * environment, and a password containing a URL-reserved character makes it
 * fail with "invalid port number in database URL". This wrapper applies the
 * same normalisation to both variables in the CHILD process only. It never
 * prints either value.
 *
 * Kept dependency-free and duplicated from db-url.ts on purpose: the npm
 * scripts that call it must work before anything is built or transpiled.
 */
import { spawnSync } from 'node:child_process';

const URL_SHAPE = /^([a-z][a-z0-9+.-]*):\/\/([^:/@]*)(?::(.*))?@([^@]*)$/i;

function isAlreadyEncoded(password) {
  if (!/%/.test(password)) return false;
  if (!/^(?:[A-Za-z0-9\-._~]|%[0-9A-Fa-f]{2})*$/.test(password)) return false;
  try {
    decodeURIComponent(password);
    return true;
  } catch {
    return false;
  }
}

export function normalizeDatabaseUrl(raw) {
  if (!raw) return raw;
  const match = raw.match(URL_SHAPE);
  if (!match) return raw;
  const [, scheme, user, password, rest] = match;
  if (password === undefined || password === '' || isAlreadyEncoded(password)) return raw;
  return `${scheme}://${user}:${encodeURIComponent(password)}@${rest}`;
}

const [, , command, ...args] = process.argv;
if (!command) {
  console.error('Usage: node scripts/db/with-encoded-env.mjs <command> [...args]');
  process.exit(1);
}

const env = { ...process.env };
for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
  if (env[key]) env[key] = normalizeDatabaseUrl(env[key]);
}
// DIRECT_URL is optional for local development: default it to DATABASE_URL so
// `prisma migrate` works against a plain local server with one variable set.
if (!env.DIRECT_URL && env.DATABASE_URL) env.DIRECT_URL = env.DATABASE_URL;

const result = spawnSync(command, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
process.exit(result.status ?? 1);

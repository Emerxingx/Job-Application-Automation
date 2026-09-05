/**
 * Build-time configuration. `EXPO_PUBLIC_*` variables are inlined by Expo at
 * bundle time and are PUBLIC by definition - nothing secret goes here, and
 * the app holds no secret of its own: the only credential is the device key
 * the person's sign-in mints, kept in secure storage (src/auth/storage.ts).
 */
const DEFAULT_BASE_URL = 'http://localhost:3000';

export function apiBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.EXPO_PUBLIC_API_BASE_URL ?? DEFAULT_BASE_URL).trim();
  const url = raw.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url)) throw new Error(`EXPO_PUBLIC_API_BASE_URL must be an http(s) URL, got ${raw}`);
  return url;
}

/** Production builds refuse a plain-http API: the device key would travel in the clear. */
export function assertTransportSecure(url: string, isDev: boolean): void {
  if (!isDev && url.startsWith('http://')) throw new Error('A release build must talk to the API over https.');
}

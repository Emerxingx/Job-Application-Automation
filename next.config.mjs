import { withPayload } from '@payloadcms/next/withPayload';
import { SECURITY_HEADERS } from './security-headers.mjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep the server bundle lean; these are loaded at runtime on the server only.
  // `payload` and the SQLite adapter are listed because Payload's CLI entry
  // points (type generation) sit in the same package graph as the runtime
  // adapter — bundling them drags in build-only deps like `cli-color`.
  serverExternalPackages: [
    '@prisma/client',
    'bcryptjs',
    'payload',
    '@payloadcms/db-sqlite',
    '@payloadcms/db-postgres',
    'sharp',
  ],
  // There is deliberately no `eslint` key. It carried
  // `{ ignoreDuringBuilds: true }` from before ESLint was installed at all;
  // once CI gained a blocking lint job (ADR-0018) it stopped meaning anything,
  // and Next 16 no longer recognises the key — it warned on every production
  // build. Lint runs as its own gate, not as part of `next build`.

  // Stage 23 (ADR-0037): the same header list on every route, including the
  // Payload admin and the API. The list lives in security-headers.mjs so the
  // static test reads exactly what ships.
  async headers() {
    return [{ source: '/(.*)', headers: SECURITY_HEADERS }];
  },
};

export default withPayload(nextConfig);

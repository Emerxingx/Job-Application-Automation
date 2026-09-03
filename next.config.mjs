import { withPayload } from '@payloadcms/next/withPayload';

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
};

export default withPayload(nextConfig);

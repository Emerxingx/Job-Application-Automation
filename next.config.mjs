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
  eslint: { ignoreDuringBuilds: true },
};

export default withPayload(nextConfig);

/* THIS FILE IS PART OF THE PAYLOAD ADMIN INTEGRATION.
 * It intentionally does NOT import the app's global stylesheet — the admin UI
 * ships its own styles, and Tailwind's preflight would fight them.
 */
import type { ReactNode } from 'react';
import { RootLayout, handleServerFunctions } from '@payloadcms/next/layouts';
import type { ServerFunctionClient } from 'payload';
import config from '@payload-config';
// The admin UI's own stylesheet. Without it the admin renders as unstyled
// HTML — functional but unusable.
import '@payloadcms/next/css';

import { importMap } from './admin/importMap';

type Args = { children: ReactNode };

const serverFunction: ServerFunctionClient = async function (args) {
  'use server';
  return handleServerFunctions({ ...args, config, importMap });
};

export default function PayloadLayout({ children }: Args) {
  return (
    <RootLayout config={config} importMap={importMap} serverFunction={serverFunction}>
      {children}
    </RootLayout>
  );
}

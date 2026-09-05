import { NextResponse } from 'next/server';
import { clearImpersonationCookie, currentImpersonation } from '@/lib/auth';
import { endImpersonation } from '@/lib/admin/impersonation';
import { requestMeta } from '@/lib/security-audit';

/**
 * POST /api/console/impersonation/end - end the impersonation this request
 * runs under. Deliberately NOT wrapped in route(): under an impersonation
 * every non-GET request is refused by route(), and this is the one write
 * that must still work - it is the way out. It identifies the staff member
 * from the impersonation token itself (the row and the staff session are
 * checked live), ends the row, clears the cookie and sends them to the console.
 */
export async function POST(request: Request) {
  const current = await currentImpersonation();
  if (current) await endImpersonation({ impersonationId: current.impersonationId, staffId: current.staffId, by: 'staff' }, requestMeta(request));
  await clearImpersonationCookie();
  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('text/html')) return NextResponse.redirect(new URL('/console/users', request.url), 303);
  return NextResponse.json({ ended: current !== null, redirect: '/console/users' });
}

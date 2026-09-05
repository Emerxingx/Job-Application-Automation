import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { Logo } from '@/components/site-header';
import { AuthForm } from '@/components/auth-form';
import { SsoSignIn } from '@/components/sso-sign-in';
import { isFlagEnabled } from '@/lib/admin/feature-flags';

export const metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ demo?: string; sso?: string }>;
}) {
  if (await getCurrentUser()) redirect('/dashboard');
  const params = await searchParams;
  // Stage 20: the enterprise entry point is a declared feature flag (ADR-0019 Tier 1).
  const showSso = await isFlagEnabled('auth.sso_start_button', null);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-bg px-4 py-12">
      <Link href="/" className="mb-8" aria-label="JobPilot AI home">
        <Logo />
      </Link>

      <div className="card w-full max-w-md p-8">
        <h1 className="text-2xl font-bold tracking-tight text-ink">Welcome back</h1>
        <p className="mt-1.5 text-sm text-muted">Sign in to pick up where your agents left off.</p>

        <AuthForm mode="login" prefillDemo={params.demo === '1'} />

        {showSso || params.sso ? <SsoSignIn message={params.sso} /> : null}

        <p className="mt-6 text-center text-sm text-muted">
          New here?{' '}
          <Link href="/signup" className="font-semibold text-brand-500 hover:text-brand-600">
            Create an account
          </Link>
        </p>
      </div>

      <div className="mt-6 w-full max-w-md rounded-xl border border-line bg-raised p-4 text-center">
        <p className="text-xs font-semibold text-ink">Demo account</p>
        <p className="mt-1 text-xs text-muted">
          <code className="rounded bg-surface px-1.5 py-0.5">demo@jobpilot.ai</code>
          {' · '}
          <code className="rounded bg-surface px-1.5 py-0.5">demo1234</code>
        </p>
      </div>
    </main>
  );
}

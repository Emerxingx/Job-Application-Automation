import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { Logo } from '@/components/site-header';
import { AuthForm } from '@/components/auth-form';

export const metadata = { title: 'Create your account' };

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; interval?: string }>;
}) {
  if (await getCurrentUser()) redirect('/dashboard');
  const params = await searchParams;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg px-4 py-12">
      <Link href="/" className="mb-8" aria-label="JobPilot AI home">
        <Logo />
      </Link>

      <div className="card w-full max-w-md p-8">
        <h1 className="text-2xl font-bold tracking-tight text-ink">Create your account</h1>
        <p className="mt-1.5 text-sm text-muted">
          Start with the Starter plan free — upgrade whenever you need more volume.
        </p>

        <AuthForm mode="signup" plan={params.plan} interval={params.interval} />

        <p className="mt-6 text-center text-sm text-muted">
          Already have an account?{' '}
          <Link href="/login" className="font-semibold text-brand-500 hover:text-brand-600">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

import Link from 'next/link';
import { Plane } from 'lucide-react';

export function Logo({ className }: { className?: string }) {
  return (
    <span className={className}>
      <span className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-500">
          <Plane className="h-4 w-4 -rotate-45 text-white" />
        </span>
        <span className="text-base font-bold tracking-tight text-ink">JobPilot AI</span>
      </span>
    </span>
  );
}

export function SiteHeader({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-md">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <Link href="/" aria-label="JobPilot AI home">
          <Logo />
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          <a href="#how" className="text-sm font-medium text-muted transition hover:text-ink">
            How it works
          </a>
          <a href="#features" className="text-sm font-medium text-muted transition hover:text-ink">
            Features
          </a>
          <a href="#pricing" className="text-sm font-medium text-muted transition hover:text-ink">
            Pricing
          </a>
        </div>

        <div className="flex items-center gap-2">
          {signedIn ? (
            <Link href="/dashboard" className="btn-primary">
              Open dashboard
            </Link>
          ) : (
            <>
              <Link href="/login" className="btn-ghost hidden sm:inline-flex">
                Sign in
              </Link>
              <Link href="/signup" className="btn-primary">
                Get started
              </Link>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}

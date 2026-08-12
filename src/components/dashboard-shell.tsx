'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  CreditCard,
  FileText,
  FolderTree,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  Menu,
  MessagesSquare,
  Radar,
  Search,
  Settings,
  X,
} from 'lucide-react';
import { Logo } from '@/components/site-header';
import { Meter, cn } from '@/components/ui';

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/agents', label: 'Job agents', icon: Radar },
  { href: '/dashboard/jobs', label: 'Job feed', icon: Search },
  { href: '/dashboard/applications', label: 'Applications', icon: FolderTree },
  { href: '/dashboard/interview-prep', label: 'Interview prep', icon: MessagesSquare },
  { href: '/dashboard/resume', label: 'My resume', icon: FileText },
  { href: '/dashboard/billing', label: 'Plan & billing', icon: CreditCard },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
];

interface QuotaView {
  used: number;
  limit: number;
  planName: string;
  periodEnd: string;
}

export function DashboardShell({
  user,
  quota,
  children,
}: {
  user: { fullName: string; email: string };
  quota: QuotaView | null | undefined;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/');
    router.refresh();
  }

  const initials = user.fullName
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const nav = (
    <>
      <nav className="flex-1 space-y-1 px-3">
        {NAV.map((item) => {
          // Only the exact path is "active" for the overview root.
          const active =
            item.href === '/dashboard'
              ? pathname === '/dashboard'
              : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition',
                active
                  ? 'bg-brand-500/10 text-brand-600'
                  : 'text-muted hover:bg-raised hover:text-ink',
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-line p-3">
        {quota && (
          <div className="mb-3 rounded-xl bg-raised p-3">
            <Meter used={quota.used} total={quota.limit} label={`${quota.planName} plan`} />
            <p className="mt-2 text-xs text-faint">
              Resets {new Date(quota.periodEnd).toLocaleDateString('en-CA', {
                month: 'short',
                day: 'numeric',
              })}
            </p>
          </div>
        )}

        <div className="flex items-center gap-3 rounded-xl px-2 py-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-500 text-xs font-bold text-white">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink">{user.fullName}</p>
            <p className="truncate text-xs text-faint">{user.email}</p>
          </div>
          <button
            onClick={signOut}
            aria-label="Sign out"
            className="rounded-lg p-1.5 text-faint transition hover:bg-surface hover:text-danger"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </>
  );

  return (
    <div className="min-h-screen bg-bg">
      {/* Mobile top bar */}
      <div className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-line bg-bg/90 px-4 backdrop-blur lg:hidden">
        <Link href="/dashboard" aria-label="Dashboard">
          <Logo />
        </Link>
        <button
          onClick={() => setMobileOpen((v) => !v)}
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileOpen}
          className="rounded-lg p-2 text-muted hover:bg-raised"
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-30 lg:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <div className="absolute inset-y-0 left-0 flex w-72 flex-col bg-surface pt-16 shadow-lift">
            {nav}
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-line bg-surface lg:flex">
        <div className="flex h-16 items-center px-5">
          <Link href="/dashboard" aria-label="Dashboard">
            <Logo />
          </Link>
        </div>
        {nav}
      </aside>

      <main className="lg:pl-64">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">{children}</div>
      </main>
    </div>
  );
}

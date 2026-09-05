'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowLeft,
  BarChart3,
  LayoutDashboard,
  LifeBuoy,
  Menu,
  Receipt,
  Sparkles,
  BookOpen,
  Scale,
  Plug,
  ListChecks,
  SlidersHorizontal,
  Users,
  X,
  type LucideIcon,
  Building2,
  UserCog,
  ToggleLeft,
  ScrollText,
} from 'lucide-react';
import { cn } from '@/components/ui';
// TYPE ONLY, and it has to stay that way. `lib/crm/auth` imports `requireUser`,
// which reaches `next/headers` and the Prisma client; a value import here would
// drag both into the browser bundle and break the build. Type imports are
// erased at compile time, so this one costs nothing.
import type { StaffRole } from '@/lib/crm/auth';

/**
 * The privilege ladder, mirrored for the client.
 *
 * `STAFF_RANK` in lib/crm/auth.ts is the authority; this copy exists only
 * because that module cannot be imported for its values here. Drift is
 * harmless in the safe direction: this map decides which links are *offered*,
 * while every page and route re-derives the real answer server-side. A stale
 * copy can show a link that then refuses — never open a door the server would
 * have shut.
 */
const ROLE_RANK: Record<StaffRole, number> = { support: 1, billing_ops: 2, admin: 3 };

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Weakest role that may open this page. Mirrors the page's own gate. */
  minRole: StaffRole;
}

/**
 * The console's map.
 *
 * `minRole` is a duplicate of each page's own `consoleGate(...)` call, and it
 * has to be: this list only decides what is *offered*. Hiding a link is not
 * access control, and the pages are what actually refuse. Keeping the two in
 * sync means a support agent is never shown a door that will be shut in their
 * face — a permission error they cannot act on is worse than no link.
 */
const NAV: NavItem[] = [
  { href: '/console', label: 'Overview', icon: LayoutDashboard, minRole: 'support' },
  { href: '/console/customers', label: 'Customers', icon: Users, minRole: 'support' },
  { href: '/console/revenue', label: 'Revenue', icon: BarChart3, minRole: 'billing_ops' },
  { href: '/console/invoices', label: 'Invoices', icon: Receipt, minRole: 'billing_ops' },
  { href: '/console/tickets', label: 'Support', icon: LifeBuoy, minRole: 'support' },
  { href: '/console/prompts', label: 'Prompts', icon: Sparkles, minRole: 'admin' },
  { href: '/console/taxonomy', label: 'Taxonomy', icon: BookOpen, minRole: 'admin' },
  { href: '/console/sources', label: 'Job sources', icon: Plug, minRole: 'admin' },
  { href: '/console/ats-rulesets', label: 'ATS rulesets', icon: ListChecks, minRole: 'admin' },
  { href: '/console/match-weights', label: 'Match weights', icon: SlidersHorizontal, minRole: 'admin' },
  { href: '/console/field-mappings', label: 'Field mappings', icon: ListChecks, minRole: 'admin' },
  { href: '/console/staffing', label: 'Staffing rules', icon: Scale, minRole: 'admin' },
  { href: '/console/organizations', label: 'Organisations', icon: Building2, minRole: 'support' },
  { href: '/console/users', label: 'Users', icon: UserCog, minRole: 'support' },
  { href: '/console/flags', label: 'Feature flags', icon: ToggleLeft, minRole: 'support' },
  { href: '/console/audit', label: 'Audit log', icon: ScrollText, minRole: 'admin' },
];

const ROLE_LABEL: Record<StaffRole, string> = {
  support: 'Support',
  billing_ops: 'Billing ops',
  admin: 'Admin',
};

export interface ConsoleStaffView {
  fullName: string;
  email: string;
  role: StaffRole;
}

export function ConsoleShell({
  staff,
  children,
}: {
  staff: ConsoleStaffView;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const items = NAV.filter((item) => ROLE_RANK[staff.role] >= ROLE_RANK[item.minRole]);
  const isActive = (href: string) =>
    href === '/console' ? pathname === '/console' : pathname.startsWith(href);

  const links = items.map((item) => (
    <Link
      key={item.href}
      href={item.href}
      onClick={() => setOpen(false)}
      aria-current={isActive(item.href) ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors duration-150',
        'motion-reduce:transition-none',
        isActive(item.href)
          ? 'bg-brand-500/10 text-brand-600'
          : 'text-muted hover:bg-raised hover:text-ink',
      )}
    >
      <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {item.label}
    </Link>
  ));

  return (
    <div className="min-h-screen bg-bg">
      {/*
       * The console and the customer dashboard look alike enough that a tab
       * left open is easy to mistake. This strip is the standing reminder that
       * everything below it is somebody else's personal data — and that
       * anything done here is attributable.
       */}
      <div className="border-b border-warn/30 bg-warn/10 px-4 py-1.5 text-center text-xs font-medium text-warn">
        Internal staff console — you are looking at customers&rsquo; personal data. Actions are
        recorded against {staff.email}.
      </div>

      <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[100rem] items-center gap-3 px-4 sm:px-6">
          <Link href="/console" className="flex shrink-0 items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-ink text-xs font-black text-bg">
              JP
            </span>
            <span className="text-sm font-bold tracking-tight text-ink">Console</span>
          </Link>

          <nav aria-label="Console" className="ml-2 hidden items-center gap-1 md:flex">
            {links}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-xs font-semibold leading-tight text-ink">{staff.fullName}</p>
              <p className="text-[11px] leading-tight text-faint">{ROLE_LABEL[staff.role]}</p>
            </div>
            <Link
              href="/dashboard"
              className="btn-ghost hidden px-2.5 py-1.5 text-xs sm:inline-flex"
              title="Leave the console"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              My account
            </Link>
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              aria-label={open ? 'Close console menu' : 'Open console menu'}
              className="rounded-lg p-2 text-muted hover:bg-raised md:hidden"
            >
              {open ? (
                <X className="h-5 w-5" aria-hidden="true" />
              ) : (
                <Menu className="h-5 w-5" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        {open && (
          <nav aria-label="Console" className="space-y-1 border-t border-line px-4 py-3 md:hidden">
            {links}
            <Link
              href="/dashboard"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-muted hover:bg-raised hover:text-ink"
            >
              <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
              My account
            </Link>
          </nav>
        )}
      </header>

      {/* Wider than the customer app on purpose: these pages are tables. */}
      <main className="mx-auto max-w-[100rem] px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}

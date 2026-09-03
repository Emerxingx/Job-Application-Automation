import Link from 'next/link';
import { Logo } from '@/components/site-header';

/**
 * Shell for the legal documents the signup consent refers to.
 *
 * The WORDING of these documents is a founder-and-counsel deliverable
 * (docs/governance/COMPLIANCE_REGISTER.md, L-5 and the consent obligations
 * under ADR-0015). Engineering does not draft it and must not present a
 * placeholder as though it were the document. Until the founder publishes the
 * text, each page states exactly that, together with the version identifier
 * the platform records against a consent — so what a user agreed to is at
 * least unambiguous, even while what it says is pending.
 */
export function LegalDocument({
  title,
  version,
  summary,
}: {
  title: string;
  version: string;
  summary: string;
}) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col px-4 py-12">
      <Link href="/" className="mb-8 self-start" aria-label="JobPilot AI home">
        <Logo />
      </Link>
      <h1 className="text-3xl font-bold tracking-tight text-ink">{title}</h1>
      <p className="mt-2 text-sm text-muted">
        Document version <code className="rounded bg-surface px-1.5 py-0.5 text-xs">{version}</code>
      </p>
      <section aria-labelledby="status-heading" className="card mt-8 p-6">
        <h2 id="status-heading" className="text-base font-semibold text-ink">
          Status: text pending publication
        </h2>
        <p className="mt-2 text-sm text-ink">{summary}</p>
        <p className="mt-2 text-sm text-muted">
          The final wording is being prepared with legal counsel and will be published at this
          address under the version shown above. When you create an account, the platform records
          which version you agreed to and when; if the version changes you will be asked to review
          the new one.
        </p>
      </section>
    </main>
  );
}

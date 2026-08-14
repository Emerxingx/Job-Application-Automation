/**
 * A launcher in the CMS admin nav that jumps staff to the client-management
 * console.
 *
 * The CRM itself deliberately lives at /console, behind requireStaff()'s
 * allowlist + role gate, because it shows customer PII and billing — a
 * different trust boundary than CMS content editing. This link makes the two
 * feel unified without moving the data across that boundary: a CMS editor who
 * is not staff clicks through and lands on the console's own denial page.
 */
export default function CrmLauncher() {
  return (
    <a
      href="/console"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        margin: '16px 0 0',
        padding: '8px 12px',
        borderRadius: '4px',
        border: '1px solid var(--theme-elevation-150)',
        color: 'var(--theme-elevation-800)',
        textDecoration: 'none',
        fontSize: '13px',
        fontWeight: 600,
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
      Client Management (CRM)
      <span style={{ marginLeft: 'auto', fontSize: '11px', opacity: 0.6 }}>↗</span>
    </a>
  );
}

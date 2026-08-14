'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowUpRight,
  Briefcase,
  Download,
  FileText,
  Files,
  FolderTree,
  Mail,
  MessagesSquare,
  Receipt,
  UserRound,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { DataTable, type Column } from '@/components/data-table';
import { FilterBar, SearchInput, SelectFilter } from '@/components/filters';
import { cn } from '@/components/ui';
import type { DocumentKind, DocumentRowView, KindOption } from './types';

const KIND_META: Record<DocumentKind, { label: string; icon: LucideIcon; className: string }> = {
  master_resume: { label: 'Master resume', icon: UserRound, className: 'text-brand-500' },
  resume: { label: 'Tailored resume', icon: FileText, className: 'text-brand-500' },
  cover_letter: { label: 'Cover letter', icon: Mail, className: 'text-success' },
  job_description: { label: 'Job description', icon: Briefcase, className: 'text-muted' },
  folder: { label: 'Application folder', icon: FolderTree, className: 'text-warn' },
  interview_prep: { label: 'Interview prep', icon: MessagesSquare, className: 'text-brand-500' },
  invoice: { label: 'Invoice', icon: Receipt, className: 'text-muted' },
};

export function DocumentLibrary({
  rows,
  kindOptions,
}: {
  rows: DocumentRowView[];
  kindOptions: KindOption[];
}) {
  const [kind, setKind] = useState('');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (kind && row.kind !== kind) return false;
      if (!needle) return true;
      return (
        row.title.toLowerCase().includes(needle) || row.context.toLowerCase().includes(needle)
      );
    });
  }, [rows, kind, query]);

  const dirty = kind !== '' || query.trim() !== '';

  const columns: Column<DocumentRowView>[] = [
    {
      key: 'title',
      header: 'Document',
      sortable: true,
      render: (row) => {
        const meta = KIND_META[row.kind];
        const Icon = meta.icon;
        return (
          <span className="flex min-w-0 items-start gap-2.5">
            <span
              className={cn(
                'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-raised',
                meta.className,
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            {/* No `truncate` here on purpose: `white-space: nowrap` forces an
                auto-layout table column to its widest cell, which turned a
                390px screen into an 824px-wide table. Wrapping keeps the table
                near the width of its container. */}
            <span className="min-w-0">
              <span className="block break-words font-semibold text-ink">{row.title}</span>
              <span className="block break-words text-xs text-muted">{row.context}</span>
              {/* The type column is hidden on small screens, so repeat it here. */}
              <span className="mt-0.5 block text-xs text-faint md:hidden">
                {meta.label} · {row.dateLabel}
              </span>
            </span>
          </span>
        );
      },
    },
    {
      key: 'kind',
      header: 'Type',
      hideBelow: 'md',
      sortable: true,
      searchText: (row) => KIND_META[row.kind].label,
      render: (row) => <span className="text-muted">{KIND_META[row.kind].label}</span>,
    },
    {
      key: 'formatLabel',
      header: 'Format',
      hideBelow: 'lg',
      render: (row) => <span className="chip">{row.formatLabel}</span>,
    },
    {
      key: 'dateLabel',
      header: 'Created',
      hideBelow: 'md',
      sortable: true,
      sortValue: (row) => row.dateIso,
      render: (row) => <span className="whitespace-nowrap text-muted">{row.dateLabel}</span>,
    },
    {
      key: 'actions',
      // Visible rather than `headerSrOnly` — see the note in
      // dashboard/invoices/invoice-table.tsx: an absolutely positioned
      // `.sr-only` span in the last column escapes the scroll container and
      // widens the page body.
      header: 'Get',
      align: 'right',
      width: '7rem',
      searchText: () => '',
      render: (row) =>
        row.downloadUrl ? (
          <a
            href={row.downloadUrl}
            className="btn-secondary px-2.5 py-1.5 text-xs"
            aria-label={`Download ${row.title}`}
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Download
          </a>
        ) : row.viewUrl ? (
          <Link
            href={row.viewUrl}
            className="btn-secondary px-2.5 py-1.5 text-xs"
            aria-label={`Open ${row.title}`}
          >
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            Open
          </Link>
        ) : null,
    },
  ];

  return (
    <>
      <FilterBar
        onReset={() => {
          setKind('');
          setQuery('');
        }}
        canReset={dirty}
        summary={
          dirty
            ? `${filtered.length} of ${rows.length} document${rows.length === 1 ? '' : 's'}`
            : `${rows.length} document${rows.length === 1 ? '' : 's'}`
        }
      >
        {/* A width is set because `.input` is `w-full` and a bare flex item
            sizes to its widest <option>; "Application folders (12)" would
            otherwise stretch the filter row past the viewport. */}
        <SelectFilter
          label="Type"
          value={kind}
          onChange={setKind}
          anyLabel={`All types (${rows.length})`}
          className="w-full sm:w-52"
          options={kindOptions.map((option) => ({
            value: option.value,
            label: option.label,
            count: option.count,
          }))}
        />
        <SearchInput
          value={query}
          onChange={setQuery}
          label="Search documents"
          placeholder="Company, role or invoice"
          className="w-full sm:w-64"
        />
      </FilterBar>

      <div className="card overflow-hidden">
        <DataTable
          caption="Generated documents"
          rows={filtered}
          columns={columns}
          rowKey={(row) => row.id}
          pageSize={25}
          initialSort={{ key: 'dateLabel', direction: 'desc' }}
          empty={{
            icon: <Files className="h-5 w-5" aria-hidden="true" />,
            title: dirty ? 'Nothing matches those filters' : 'No documents yet',
            description: dirty
              ? 'Clear the filters above to see everything JobPilot has generated for you.'
              : 'Every tailored resume, cover letter and interview pack JobPilot generates lands here automatically.',
          }}
        />
      </div>
    </>
  );
}

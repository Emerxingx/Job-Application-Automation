import { useRouter } from 'expo-router';
import React from 'react';
import { PATHS } from '@/api/client';
import { useSession } from '@/auth/session';
import { useQuery } from '@/hooks/use-query';
import { formatDate, statusLabel } from '@/lib/format';
import { Card, EmptyState, ErrorState, ListRow, LoadingState, Muted, OfflineBanner, Screen, Title } from '@/ui/components';

const PAGE = { limit: 50 };

/** Every folder, the ones awaiting the applicant first (GET /v1/applications). */
export default function Applications() {
  const router = useRouter();
  const { client } = useSession();
  const q = useQuery(PATHS.applications, () => client.applications(PAGE), PAGE);
  const rows = q.data?.data ?? [];
  const waiting = rows.filter((a) => a.status === 'ready_to_submit');
  const attention = rows.filter((a) => a.status === 'failed');
  const rest = rows.filter((a) => a.status !== 'ready_to_submit' && a.status !== 'failed');
  const open = (id: string) => router.push({ pathname: '/(app)/applications/[applicationId]', params: { applicationId: id } });
  const row = (a: (typeof rows)[number]) => <ListRow key={a.id} title={`${a.job.title} · ${a.job.company}`} subtitle={`${statusLabel(a.status)} · match ${Math.round(a.matchScore)}%${a.appliedAt ? ` · sent ${formatDate(a.appliedAt)}` : ''}`} meta={formatDate(a.updatedAt)} onPress={() => open(a.id)} accessibilityHint="Opens the application folder" />;
  return (
    <Screen refreshing={q.refreshing} onRefresh={q.refresh}>
      <Title>Applications</Title>
      {q.fromCache ? <OfflineBanner storedAt={q.storedAt} /> : null}
      {q.loading ? <LoadingState /> : null}
      {!q.loading && q.error && !q.fromCache ? <ErrorState error={q.error} onRetry={q.refresh} /> : null}
      {!q.loading && !q.error && rows.length === 0 ? <EmptyState title="No applications yet" body="When JobPilot prepares an application for a recommended job, it appears here for your review. Nothing is ever sent without you." /> : null}
      {waiting.length > 0 ? (
        <Card>
          <Title level={3}>Waiting for your review ({waiting.length})</Title>
          <Muted>Prepared and ready. Open one to review every field and decide.</Muted>
          {waiting.map(row)}
        </Card>
      ) : null}
      {attention.length > 0 ? (
        <Card>
          <Title level={3}>Needs attention ({attention.length})</Title>
          {attention.map(row)}
        </Card>
      ) : null}
      {rest.length > 0 ? <Title level={2}>All folders</Title> : null}
      {rest.map(row)}
      {q.data && q.data.pagination.hasMore ? <Muted style={{ marginTop: 8 }}>Showing {rows.length} of {q.data.pagination.total}. Older folders are on the web.</Muted> : null}
    </Screen>
  );
}

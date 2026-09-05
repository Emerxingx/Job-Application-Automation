import { useRouter } from 'expo-router';
import React from 'react';
import { PATHS } from '@/api/client';
import { useSession } from '@/auth/session';
import { useQuery } from '@/hooks/use-query';
import { formatDateTime, humanise } from '@/lib/format';
import { EmptyState, ErrorState, ListRow, LoadingState, Muted, OfflineBanner, Screen, Title } from '@/ui/components';

const PAGE = { limit: 50 };

/** Every interview across the folders, soonest first (GET /v1/interviews). */
export default function Interviews() {
  const router = useRouter();
  const { client } = useSession();
  const q = useQuery(PATHS.interviews, () => client.interviews(PAGE), PAGE);
  const rows = q.data?.data ?? [];
  const now = Date.now();
  const upcoming = rows.filter((i) => Date.parse(i.scheduledAt) >= now);
  const past = rows.filter((i) => Date.parse(i.scheduledAt) < now);
  return (
    <Screen refreshing={q.refreshing} onRefresh={q.refresh}>
      <Title>Interviews</Title>
      {q.fromCache ? <OfflineBanner storedAt={q.storedAt} /> : null}
      {q.loading ? <LoadingState /> : null}
      {!q.loading && q.error && !q.fromCache ? <ErrorState error={q.error} onRetry={q.refresh} /> : null}
      {!q.loading && !q.error && rows.length === 0 ? <EmptyState title="No interviews recorded" body="Interviews you add to a folder on the web, or that the mailbox connection detects, appear here." /> : null}
      {upcoming.length > 0 ? <Title level={2}>Upcoming</Title> : null}
      {upcoming.map((i) => (
        <ListRow key={i.id} title={i.job ? `${i.job.title} · ${i.job.company}` : humanise(i.kind)} subtitle={`${humanise(i.kind)} · ${formatDateTime(i.scheduledAt)}`} meta={humanise(i.result)} onPress={() => router.push({ pathname: '/(app)/applications/[applicationId]', params: { applicationId: i.applicationId } })} />
      ))}
      {past.length > 0 ? <Title level={2}>Past</Title> : null}
      {past.map((i) => (
        <ListRow key={i.id} title={i.job ? `${i.job.title} · ${i.job.company}` : humanise(i.kind)} subtitle={`${humanise(i.kind)} · ${formatDateTime(i.scheduledAt)}`} meta={humanise(i.result)} onPress={() => router.push({ pathname: '/(app)/applications/[applicationId]', params: { applicationId: i.applicationId } })} />
      ))}
      {rows.length > 0 ? <Muted style={{ marginTop: 12 }}>Interview preparation and notes stay on the web.</Muted> : null}
    </Screen>
  );
}

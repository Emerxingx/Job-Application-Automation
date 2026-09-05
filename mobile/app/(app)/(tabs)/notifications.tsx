import { useRouter } from 'expo-router';
import React from 'react';
import { PATHS } from '@/api/client';
import { useSession } from '@/auth/session';
import { useQuery } from '@/hooks/use-query';
import { formatDateTime, humanise } from '@/lib/format';
import { EmptyState, ErrorState, ListRow, LoadingState, Muted, OfflineBanner, Screen, Title } from '@/ui/components';

const PAGE = { limit: 50 };

/**
 * What happened, newest first (GET /v1/notifications): the activity feed and
 * the mailbox-derived detections, which carry ids only. There is no push
 * channel yet (ADR-0011 is pending), so this screen is pull: open it, or
 * pull to refresh.
 */
export default function Notifications() {
  const router = useRouter();
  const { client } = useSession();
  const q = useQuery(PATHS.notifications, () => client.notifications(PAGE), PAGE);
  const rows = q.data?.data ?? [];
  return (
    <Screen refreshing={q.refreshing} onRefresh={q.refresh}>
      <Title>Activity</Title>
      {q.fromCache ? <OfflineBanner storedAt={q.storedAt} /> : null}
      {q.loading ? <LoadingState /> : null}
      {!q.loading && q.error && !q.fromCache ? <ErrorState error={q.error} onRetry={q.refresh} /> : null}
      {!q.loading && !q.error && rows.length === 0 ? <EmptyState title="Nothing yet" body="Scans, prepared applications and detected employer replies show up here." /> : null}
      {rows.map((n) => (
        <ListRow key={`${n.kind}:${n.id}`} title={n.message} subtitle={`${n.kind === 'integration' ? 'Mailbox' : humanise(n.type)} · ${formatDateTime(n.createdAt)}`} onPress={n.applicationId ? () => router.push({ pathname: '/(app)/applications/[applicationId]', params: { applicationId: n.applicationId ?? '' } }) : undefined} />
      ))}
      <Muted style={{ marginTop: 12 }}>Push notifications are not enabled: this list updates when you open it. Nothing personal travels in a notification.</Muted>
    </Screen>
  );
}

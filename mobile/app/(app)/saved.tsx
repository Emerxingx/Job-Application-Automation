import { useRouter } from 'expo-router';
import React from 'react';
import { PATHS } from '@/api/client';
import { useSession } from '@/auth/session';
import { useQuery } from '@/hooks/use-query';
import { formatDate, formatSalary } from '@/lib/format';
import { EmptyState, ErrorState, ListRow, LoadingState, Muted, OfflineBanner, Screen, Title } from '@/ui/components';

const PAGE = { limit: 50 };

/** The postings the person saved (GET /v1/saved-jobs). */
export default function SavedJobs() {
  const router = useRouter();
  const { client } = useSession();
  const q = useQuery(PATHS.savedJobs, () => client.savedJobs(PAGE), PAGE);
  const rows = q.data?.data ?? [];
  return (
    <Screen refreshing={q.refreshing} onRefresh={q.refresh}>
      <Title>Saved jobs</Title>
      {q.fromCache ? <OfflineBanner storedAt={q.storedAt} /> : null}
      {q.loading ? <LoadingState /> : null}
      {!q.loading && q.error && !q.fromCache ? <ErrorState error={q.error} onRetry={q.refresh} /> : null}
      {!q.loading && !q.error && rows.length === 0 ? <EmptyState title="No saved jobs" body="Save a job from its page to keep it here." /> : null}
      {rows.map((s) => (
        <ListRow key={s.jobId} title={s.job.title} subtitle={`${s.job.company} · ${s.job.location}${s.job.activeState === 'closed' ? ' · closed' : ''}`} meta={formatDate(s.savedAt)} onPress={() => router.push({ pathname: '/(app)/jobs/[jobId]', params: { jobId: s.jobId } })} />
      ))}
      {rows.length > 0 ? <Muted style={{ marginTop: 12 }}>{rows.map((s) => formatSalary(s.job.salaryMin, s.job.salaryMax, s.job.salaryCurrency)).filter((x) => x !== 'Salary not stated').length} of these state a salary.</Muted> : null}
    </Screen>
  );
}

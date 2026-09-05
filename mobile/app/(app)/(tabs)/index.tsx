import { useRouter } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import type { Job } from '@/api/client';
import { PATHS } from '@/api/client';
import { useSession } from '@/auth/session';
import { useQuery } from '@/hooks/use-query';
import { formatDate, formatSalary, scoreBand } from '@/lib/format';
import { Button, Card, EmptyState, ErrorState, ListRow, LoadingState, Muted, OfflineBanner, Pill, Row, Screen, Title } from '@/ui/components';

const PAGE = { limit: 25 };

/** Home: the best open, eligible, not-yet-acted-on matches (GET /v1/recommendations). */
export default function Recommendations() {
  const router = useRouter();
  const { client, me } = useSession();
  const q = useQuery(PATHS.recommendations, () => client.recommendations(PAGE), PAGE);
  const jobs = q.data?.data ?? [];
  return (
    <Screen refreshing={q.refreshing} onRefresh={q.refresh}>
      <Title>Recommended for you</Title>
      {me ? <Muted style={{ marginBottom: 12 }}>Postings your agents matched that you are eligible for, best score first. A score is one of two agents' verdicts on a posting, never a promise.</Muted> : null}
      {q.fromCache ? <OfflineBanner storedAt={q.storedAt} /> : null}
      <Row style={{ marginBottom: 8 }}>
        <Button title="Saved jobs" variant="secondary" onPress={() => router.push('/(app)/saved')} />
      </Row>
      {q.loading ? <LoadingState /> : null}
      {!q.loading && q.error && !q.fromCache ? <ErrorState error={q.error} onRetry={q.refresh} /> : null}
      {!q.loading && !q.error && jobs.length === 0 ? <EmptyState title="Nothing to recommend yet" body="Recommendations appear after your agents scan and the eligibility check passes. Set up an agent on the web to start." /> : null}
      {jobs.map((job) => (
        <JobRow key={job.match.id} job={job} onPress={() => router.push({ pathname: '/(app)/jobs/[jobId]', params: { jobId: job.id, matchId: job.match.id } })} />
      ))}
      {q.data && q.data.pagination.hasMore ? <Muted style={{ marginTop: 8 }}>Showing the top {jobs.length} of {q.data.pagination.total}. Open a job to see why it scored.</Muted> : null}
    </Screen>
  );
}

export function JobRow({ job, onPress }: { job: Job; onPress: () => void }) {
  const band = scoreBand(job.match.score);
  return (
    <Card style={{ padding: 0, paddingHorizontal: 16 }}>
      <ListRow title={job.title} subtitle={`${job.company} · ${job.location}`} meta={`${Math.round(job.match.score)}%`} onPress={onPress} accessibilityHint="Opens the job, its eligibility and match analysis" />
      <View style={{ paddingBottom: 12 }}>
        <Row>
          <Pill tone={band === 'strong' ? 'success' : band === 'good' ? 'neutral' : 'warning'}>{band === 'strong' ? 'Strong match' : band === 'good' ? 'Good match' : 'Weak match'}</Pill>
          <Pill>{job.workMode}</Pill>
          <Pill>{job.jobType}</Pill>
        </Row>
        <Muted>
          {formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency)} · posted {formatDate(job.postedAt)} · via {job.source}
        </Muted>
      </View>
    </Card>
  );
}

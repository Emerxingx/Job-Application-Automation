import React from 'react';
import { PATHS } from '@/api/client';
import { useSession } from '@/auth/session';
import { useQuery } from '@/hooks/use-query';
import { formatDate, statusLabel } from '@/lib/format';
import { Card, ErrorState, KeyValue, LoadingState, Muted, OfflineBanner, Screen, Title } from '@/ui/components';

/** Rates are parts per million over LIFETIME SUBMITTED applications (the contract says so); shown as a percentage. */
function pct(parts: number): string {
  return `${(parts / 10_000).toFixed(1)}%`;
}

/** The analytics summary (GET /v1/analytics/summary) - the same numbers the web dashboard shows, from the same definitions. */
export default function Analytics() {
  const { client } = useSession();
  const q = useQuery(PATHS.analyticsSummary, () => client.analyticsSummary());
  if (q.loading) return <Screen><LoadingState /></Screen>;
  const s = q.data;
  if (!s) return <Screen><ErrorState error={q.error} onRetry={q.refresh} /></Screen>;
  return (
    <Screen refreshing={q.refreshing} onRefresh={q.refresh}>
      {q.fromCache ? <OfflineBanner storedAt={q.storedAt} /> : null}
      <Title>Your numbers</Title>
      <Muted>Generated {formatDate(s.generatedAt)}. Last {s.window.days} days and lifetime; every metric has one definition (METRIC_DICTIONARY.md).</Muted>
      <Card style={{ marginTop: 16 }}>
        <Title level={3}>Last {s.window.days} days</Title>
        <KeyValue label="Applications prepared" value={String(s.windowed.applications)} />
        <KeyValue label="Submitted" value={String(s.windowed.submitted)} />
        <KeyValue label="Interviews" value={String(s.windowed.interviews)} />
        <KeyValue label="Offers" value={String(s.windowed.offers)} />
      </Card>
      <Card>
        <Title level={3}>Lifetime</Title>
        <KeyValue label="Applications" value={String(s.lifetime.applications)} />
        <KeyValue label="Submitted" value={String(s.lifetime.submitted)} />
        <KeyValue label="Responded" value={String(s.lifetime.responded)} />
        <KeyValue label="Interviews" value={String(s.lifetime.interviews)} />
        <KeyValue label="Offers" value={String(s.lifetime.offers)} />
      </Card>
      <Card>
        <Title level={3}>Rates (of submitted)</Title>
        <KeyValue label="Response rate" value={pct(s.rates.responseRateParts)} />
        <KeyValue label="Interview rate" value={pct(s.rates.interviewRateParts)} />
        <KeyValue label="Offer rate" value={pct(s.rates.offerRateParts)} />
        <Muted>Denominators are lifetime submitted applications, so queuing more work never lowers a rate.</Muted>
      </Card>
      <Card>
        <Title level={3}>By status</Title>
        {Object.entries(s.byStatus).map(([status, n]) => (
          <KeyValue key={status} label={statusLabel(status)} value={String(n)} />
        ))}
      </Card>
      <Card>
        <Title level={3}>Matching</Title>
        <KeyValue label="Average match score" value={`${Math.round(s.scores.averageMatchScore)}%`} />
        <KeyValue label="Average ATS score" value={`${Math.round(s.scores.averageAtsScore)}%`} />
        <KeyValue label="Agents" value={`${s.agents.active} active of ${s.agents.total}`} />
        <KeyValue label="Matches" value={`${s.matches.new} new of ${s.matches.total}`} />
      </Card>
      {s.quota ? (
        <Card>
          <Title level={3}>Plan</Title>
          <KeyValue label="Plan" value={`${s.quota.planName} (${s.quota.status})`} />
          <KeyValue label="Applications this period" value={`${s.quota.used} of ${s.quota.limit}, ${s.quota.remaining} left`} />
          <KeyValue label="Period ends" value={formatDate(s.quota.periodEnd)} />
          <Muted>Billing is managed on the web.</Muted>
        </Card>
      ) : null}
    </Screen>
  );
}

import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Linking } from 'react-native';
import { PATHS, fillPath } from '@/api/client';
import { describeError } from '@/api/errors';
import { useSession } from '@/auth/session';
import { useQuery } from '@/hooks/use-query';
import { eligibilityLabel, formatDate, formatSalary, humanise } from '@/lib/format';
import { Body, Button, Card, ErrorState, KeyValue, LoadingState, Muted, OfflineBanner, Pill, Row, Screen, Title } from '@/ui/components';

/** One posting, with the caller's eligibility verdict rule by rule (GET /v1/jobs/{jobId}) and the way to its match analysis. */
export default function JobScreen() {
  const { jobId, matchId } = useLocalSearchParams<{ jobId: string; matchId?: string }>();
  const router = useRouter();
  const { client } = useSession();
  const path = fillPath(PATHS.job, { jobId: jobId ?? '' });
  const q = useQuery(path, () => client.job(jobId ?? ''), undefined, Boolean(jobId));
  const [saved, setSaved] = useState<boolean | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const job = q.data;
  const isSaved = saved ?? job?.saved ?? false;

  const toggleSave = async () => {
    if (!job) return;
    setBusy(true);
    setSaveError(null);
    try {
      if (isSaved) await client.unsaveJob(job.id);
      else await client.saveJob(job.id);
      setSaved(!isSaved);
    } catch (e) {
      setSaveError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  if (q.loading) return <Screen><LoadingState /></Screen>;
  if (!job) return <Screen><ErrorState error={q.error ?? new Error('Job not found.')} onRetry={q.refresh} /></Screen>;
  const verdict = job.eligibility;
  const tone = verdict?.outcome === 'eligible' ? 'success' : verdict?.outcome === 'ineligible' ? 'danger' : 'warning';
  const closed = job.activeState === 'closed';

  return (
    <Screen refreshing={q.refreshing} onRefresh={q.refresh}>
      {q.fromCache ? <OfflineBanner storedAt={q.storedAt} /> : null}
      <Title>{job.title}</Title>
      <Body>{job.company} · {job.location}</Body>
      <Row style={{ marginTop: 8 }}>
        <Pill>{job.workMode}</Pill>
        <Pill>{job.jobType}</Pill>
        {closed ? <Pill tone="danger">Closed</Pill> : job.activeState === 'unknown' ? <Pill tone="warning">Unconfirmed open</Pill> : null}
      </Row>
      <Muted>{formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency)} · posted {formatDate(job.postedAt)} · via {job.source}</Muted>

      <Card style={{ marginTop: 16 }}>
        <Title level={3}>Eligibility</Title>
        <Pill tone={tone}>{eligibilityLabel(verdict?.outcome)}</Pill>
        {verdict ? (
          <>
            {verdict.rules.map((r) => (
              <KeyValue key={r.rule} label={humanise(r.rule)} value={`${humanise(r.status)} - ${r.reason}`} />
            ))}
            <Muted>Checked {formatDate(verdict.evaluatedAt)}. Hard requirements only; "unknown" never excludes you.</Muted>
          </>
        ) : (
          <Muted>This posting has not been through the eligibility check yet.</Muted>
        )}
      </Card>

      <Card>
        <Title level={3}>Match</Title>
        <Body>{Math.round(job.match.score)}% by agent “{job.match.agentName}”</Body>
        <Muted>{job.match.rationale}</Muted>
        <Button title="Why this score" variant="secondary" onPress={() => router.push({ pathname: '/(app)/matches/[matchId]', params: { matchId: matchId ?? job.match.id } })} accessibilityHint="Opens the dimension-by-dimension analysis with cited evidence" />
      </Card>

      <Card>
        <Title level={3}>About the role</Title>
        <Body>{job.description}</Body>
        {job.requirements.length > 0 ? (
          <>
            <Title level={3}>Requirements</Title>
            {job.requirements.map((r, i) => (
              <Body key={i}>• {r}</Body>
            ))}
          </>
        ) : null}
        {job.skills.length > 0 ? (
          <Row style={{ marginTop: 8 }}>
            {job.skills.map((s) => (
              <Pill key={s}>{s}</Pill>
            ))}
          </Row>
        ) : null}
      </Card>

      {saveError ? <ErrorState error={new Error(saveError)} /> : null}
      <Button title={isSaved ? 'Remove from saved' : 'Save job'} variant="secondary" onPress={toggleSave} busy={busy} disabled={q.fromCache} />
      <Button title="Open the posting" onPress={() => Linking.openURL(job.applyUrl)} accessibilityHint="Opens the employer's page in the browser; JobPilot does not apply for you here" />
      <Muted style={{ marginTop: 8 }}>Applying happens on the employer's page or, once prepared, from your Applications folder after your review. Nothing is submitted from this screen.</Muted>
    </Screen>
  );
}

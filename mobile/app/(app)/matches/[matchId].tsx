import { useLocalSearchParams } from 'expo-router';
import React from 'react';
import { PATHS, fillPath } from '@/api/client';
import { useSession } from '@/auth/session';
import { useQuery } from '@/hooks/use-query';
import { formatDate, humanise } from '@/lib/format';
import { Body, Card, ErrorState, KeyValue, LoadingState, Muted, OfflineBanner, Pill, Row, Screen, Title } from '@/ui/components';

/** Why a posting scored what it did: the Stage 08 dimensions, what matched, what is missing, and which evidence was cited (GET /v1/matches/{matchId}). */
export default function MatchScreen() {
  const { matchId } = useLocalSearchParams<{ matchId: string }>();
  const { client } = useSession();
  const path = fillPath(PATHS.match, { matchId: matchId ?? '' });
  const q = useQuery(path, () => client.match(matchId ?? ''), undefined, Boolean(matchId));
  if (q.loading) return <Screen><LoadingState /></Screen>;
  const m = q.data;
  if (!m) return <Screen><ErrorState error={q.error ?? new Error('Match not found.')} onRetry={q.refresh} /></Screen>;
  return (
    <Screen refreshing={q.refreshing} onRefresh={q.refresh}>
      {q.fromCache ? <OfflineBanner storedAt={q.storedAt} /> : null}
      <Title>{Math.round(m.score)}% compatibility</Title>
      <Muted>Scored {formatDate(m.matchedAt)} with weights {m.weightVersion}, pipeline {m.pipelineVersion}. The score is the weighted sum of the dimensions below; changing the weights never rewrites a stored score.</Muted>
      <Card style={{ marginTop: 16 }}>
        <Body>{m.rationale}</Body>
      </Card>
      {m.dimensions.map((d) => (
        <Card key={d.dimension}>
          <Title level={3}>{humanise(d.dimension)}</Title>
          <KeyValue label="Score" value={`${Math.round(d.score)} × weight ${d.weight} = ${d.contribution.toFixed(1)}`} />
          {d.matched.length > 0 ? (
            <>
              <Muted style={{ marginTop: 8 }}>Matched</Muted>
              <Row>
                {d.matched.map((x) => (
                  <Pill key={x} tone="success">{x}</Pill>
                ))}
              </Row>
            </>
          ) : null}
          {d.missing.length > 0 ? (
            <>
              <Muted style={{ marginTop: 8 }}>Missing</Muted>
              <Row>
                {d.missing.map((x) => (
                  <Pill key={x} tone="warning">{x}</Pill>
                ))}
              </Row>
            </>
          ) : null}
          {d.note ? <Muted style={{ marginTop: 8 }}>{d.note}</Muted> : null}
          <Muted style={{ marginTop: 4 }}>{d.evidenceIds.length > 0 ? `Cites ${d.evidenceIds.length} item${d.evidenceIds.length === 1 ? '' : 's'} of your approved evidence.` : 'No evidence cited for this dimension.'}</Muted>
        </Card>
      ))}
      {m.missingKeywords.length > 0 ? (
        <Card>
          <Title level={3}>Keywords the posting asks for that your evidence lacks</Title>
          <Row>
            {m.missingKeywords.map((k) => (
              <Pill key={k} tone="warning">{k}</Pill>
            ))}
          </Row>
          <Muted>Add real experience to your evidence vault on the web if you have it; JobPilot never invents a skill (ADR: the vault is the factual authority).</Muted>
        </Card>
      ) : null}
    </Screen>
  );
}

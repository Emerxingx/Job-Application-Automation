import React from 'react';
import { PATHS } from '@/api/client';
import { useSession } from '@/auth/session';
import { useQuery } from '@/hooks/use-query';
import { formatDate, humanise } from '@/lib/format';
import { Body, Card, EmptyState, ErrorState, LoadingState, Muted, OfflineBanner, Pill, Row, Screen, Title } from '@/ui/components';

const PAGE = { limit: 100 };

/** The vault, read-only (GET /v1/evidence): the claims every generated document and match explanation is grounded in. */
export default function EvidenceScreen() {
  const { client } = useSession();
  const q = useQuery(PATHS.evidence, () => client.evidence(PAGE), PAGE);
  const rows = q.data?.data ?? [];
  const approved = rows.filter((e) => e.status === 'approved');
  const drafts = rows.filter((e) => e.status === 'draft');
  return (
    <Screen refreshing={q.refreshing} onRefresh={q.refresh}>
      <Title>Career evidence</Title>
      <Muted style={{ marginBottom: 12 }}>JobPilot only writes what this vault supports: an approved claim can be reframed or reordered in a document, never invented, and an approved claim is immutable - a correction is a new version. Approve, revise or add evidence on the web.</Muted>
      {q.fromCache ? <OfflineBanner storedAt={q.storedAt} /> : null}
      {q.loading ? <LoadingState /> : null}
      {!q.loading && q.error && !q.fromCache ? <ErrorState error={q.error} onRetry={q.refresh} /> : null}
      {!q.loading && !q.error && rows.length === 0 ? <EmptyState title="No evidence yet" body="Your structured career history on the web becomes claims here once you approve them." /> : null}
      {drafts.length > 0 ? (
        <Card>
          <Title level={3}>Awaiting your approval ({drafts.length})</Title>
          <Muted>Draft claims are not used for anything until you approve them on the web.</Muted>
        </Card>
      ) : null}
      {approved.map((e) => (
        <Card key={e.id}>
          <Body>{e.claim}</Body>
          <Row style={{ marginTop: 8 }}>
            <Pill tone="success">Approved {formatDate(e.approvedAt)}</Pill>
            <Pill>{humanise(e.kind)}</Pill>
            <Pill>{humanise(e.sourceType.replace('profile_', ''))}</Pill>
            {e.version > 1 ? <Pill>v{e.version}</Pill> : null}
          </Row>
        </Card>
      ))}
      {drafts.map((e) => (
        <Card key={e.id}>
          <Body>{e.claim}</Body>
          <Row style={{ marginTop: 8 }}>
            <Pill tone="warning">Draft</Pill>
            <Pill>{humanise(e.kind)}</Pill>
          </Row>
        </Card>
      ))}
    </Screen>
  );
}

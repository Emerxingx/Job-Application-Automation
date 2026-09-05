import React, { useState } from 'react';
import { View } from 'react-native';
import { PATHS } from '@/api/client';
import { describeError } from '@/api/errors';
import { useSession } from '@/auth/session';
import { useQuery } from '@/hooks/use-query';
import { formatDateTime, humanise } from '@/lib/format';
import { Body, Button, Card, EmptyState, ErrorState, LoadingState, Muted, Pill, Screen, Title } from '@/ui/components';

/** Every device signed in to the account, this one flagged; sign the others out (GET /v1/auth/sessions, DELETE /v1/auth/sessions/{sessionId}). */
export default function Devices() {
  const { client } = useSession();
  const q = useQuery(PATHS.sessions, () => client.devices({ limit: 50 }), { limit: 50 });
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = (q.data?.data ?? []).filter((d) => !gone.has(d.id));

  const revoke = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await client.revokeDevice(id);
      setGone((g) => new Set(g).add(id));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen refreshing={q.refreshing} onRefresh={q.refresh}>
      <Title>Signed-in devices</Title>
      <Muted style={{ marginBottom: 12 }}>Each device holds its own key, which expires after 90 days. Changing your password on the web signs every device out. Browser sessions are listed on the web.</Muted>
      {q.loading ? <LoadingState /> : null}
      {!q.loading && q.error ? <ErrorState error={q.error} onRetry={q.refresh} /> : null}
      {error ? <ErrorState error={new Error(error)} /> : null}
      {!q.loading && !q.error && rows.length === 0 ? <EmptyState title="No devices" /> : null}
      {rows.map((d) => (
        <Card key={d.id}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Body style={{ flex: 1, fontWeight: '600' }}>{d.name}</Body>
            {d.current ? <Pill tone="success">This device</Pill> : <Pill>{humanise(d.platform)}</Pill>}
          </View>
          <Muted>Signed in {formatDateTime(d.createdAt)}{d.lastUsedAt ? ` · last used ${formatDateTime(d.lastUsedAt)}` : ''}{d.expiresAt ? ` · expires ${formatDateTime(d.expiresAt)}` : ''}</Muted>
          <Muted>Key {d.prefix}…</Muted>
          {!d.current ? <Button title="Sign this device out" variant="secondary" busy={busy === d.id} onPress={() => revoke(d.id)} accessibilityHint={`Revokes the key held by ${d.name}`} /> : null}
        </Card>
      ))}
    </Screen>
  );
}

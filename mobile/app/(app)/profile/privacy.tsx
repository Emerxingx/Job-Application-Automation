import React, { useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { PATHS, type Consent } from '@/api/client';
import { describeError } from '@/api/errors';
import { useSession } from '@/auth/session';
import { useQuery } from '@/hooks/use-query';
import { formatDate } from '@/lib/format';
import { Card, ErrorState, LoadingState, Muted, OfflineBanner, Screen, Title } from '@/ui/components';
import { FONT, SPACE, useTheme } from '@/ui/theme';

const WORDS: Record<Consent['purpose'], { title: string; body: string }> = {
  terms_of_service: { title: 'Terms of service', body: 'Required to hold an account. Withdrawing it means closing the account, which you do on the web.' },
  privacy_policy: { title: 'Privacy policy', body: 'Required to hold an account. Withdrawing it means closing the account, which you do on the web.' },
  marketing_email: { title: 'Marketing email', body: 'Occasional product news. Never affects recommendations.' },
  cross_border_ai_processing: { title: 'AI processing outside Canada', body: 'Not available: this consent cannot be recorded until the legal review (L-3) is complete, so no external AI processing happens for your account.' },
  mailbox_sync: { title: 'Mailbox connection', body: 'Lets a connected mailbox be read by reference (subjects, senders, dates; never a message body) to file employer replies. Connect or revoke the mailbox itself on the web.' },
  calendar_sync: { title: 'Calendar connection', body: 'Lets connected calendar events be matched to interviews. Connect or revoke the calendar itself on the web.' },
};

/** What the person has agreed to, and what they can change here (GET /v1/consents, PUT /v1/consents/{purpose}). */
export default function Privacy() {
  const t = useTheme();
  const { client } = useSession();
  const q = useQuery(PATHS.consents, () => client.consents());
  const [overrides, setOverrides] = useState<Record<string, Consent>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = (q.data?.data ?? []).map((c) => overrides[c.purpose] ?? c);

  const toggle = async (c: Consent, granted: boolean) => {
    setBusy(c.purpose);
    setError(null);
    try {
      const after = await client.setConsent(c.purpose, granted);
      setOverrides((o) => ({ ...o, [c.purpose]: after }));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen refreshing={q.refreshing} onRefresh={q.refresh}>
      <Title>Privacy & consent</Title>
      <Muted style={{ marginBottom: SPACE.md }}>Each consent is recorded with its version and date, and withdrawing one is recorded too. Your demographic self-identification, if you gave any, lives apart from everything that matches or ranks you and is not shown or editable here.</Muted>
      {q.fromCache ? <OfflineBanner storedAt={q.storedAt} /> : null}
      {q.loading ? <LoadingState /> : null}
      {!q.loading && q.error && !q.fromCache ? <ErrorState error={q.error} onRetry={q.refresh} /> : null}
      {error ? <ErrorState error={new Error(error)} /> : null}
      {rows.map((c) => {
        const words = WORDS[c.purpose];
        const locked = c.required || !c.available || q.fromCache;
        return (
          <Card key={c.purpose}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontSize: FONT.md, fontWeight: '600' }}>{words.title}</Text>
                <Text style={{ color: t.muted, fontSize: FONT.sm, marginTop: 2 }}>{words.body}</Text>
              </View>
              <Switch accessibilityLabel={words.title} accessibilityHint={locked ? 'Cannot be changed here' : c.granted ? 'Withdraws this consent' : 'Grants this consent'} value={c.granted} disabled={locked || busy === c.purpose} onValueChange={(v) => toggle(c, v)} />
            </View>
            <Muted style={{ marginTop: SPACE.sm }}>{c.granted ? `Granted ${formatDate(c.grantedAt)} (version ${c.grantedVersion}).` : c.grantedVersion ? `An older version (${c.grantedVersion}) was granted; the current version is ${c.version}.` : 'Not granted.'}</Muted>
          </Card>
        );
      })}
    </Screen>
  );
}

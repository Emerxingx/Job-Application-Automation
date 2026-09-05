import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { useSession } from '@/auth/session';
import { MODE_LABELS } from '@/lib/format';
import { Body, Button, Card, KeyValue, ListRow, Muted, Screen, Title } from '@/ui/components';

/** The account: profile summary, where things are, sign out. */
export default function Profile() {
  const router = useRouter();
  const { me, signOut, storage } = useSession();
  const [busy, setBusy] = useState(false);
  return (
    <Screen>
      <Title>{me?.fullName ?? 'You'}</Title>
      {me ? (
        <Card>
          <KeyValue label="Email" value={me.email} />
          <KeyValue label="Location" value={[me.city, me.country].filter(Boolean).join(', ')} />
          <KeyValue label="Headline" value={me.headline ?? '—'} />
          <KeyValue label="Application mode" value={MODE_LABELS[me.applicationMode] ?? me.applicationMode} />
          <Button title="Edit profile" variant="secondary" onPress={() => router.push('/(app)/profile/edit')} />
        </Card>
      ) : (
        <Card>
          <Body>Your profile could not be loaded. Pull down on another tab to retry, or sign in again.</Body>
        </Card>
      )}
      <ListRow title="Career evidence" subtitle="The claims your applications are grounded in" onPress={() => router.push('/(app)/profile/evidence')} />
      <ListRow title="Your numbers" subtitle="Applications, responses, interviews, offers" onPress={() => router.push('/(app)/profile/analytics')} />
      <ListRow title="Privacy & consent" subtitle="What you have agreed to, and what you can withdraw" onPress={() => router.push('/(app)/profile/privacy')} />
      <ListRow title="Signed-in devices" subtitle="See and sign out other phones" onPress={() => router.push('/(app)/profile/devices')} />
      <Muted style={{ marginTop: 16 }}>Documents, your structured career history, agents and billing are managed on the web. {storage.description}</Muted>
      <Button title="Sign out" variant="danger" busy={busy} onPress={async () => {
        setBusy(true);
        await signOut();
        router.replace('/sign-in');
      }} accessibilityHint="Revokes this device's key and clears what was saved on this device" />
    </Screen>
  );
}

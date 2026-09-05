import { Redirect, useRouter } from 'expo-router';
import React from 'react';
import { useSession } from '@/auth/session';
import { Body, Button, Card, Muted, Screen, Title } from '@/ui/components';

/**
 * Shown when the account has not completed onboarding on the web. The app
 * does not repeat that flow: the profile, the structured career history
 * (the Digital Twin) and evidence approval are web work by design
 * (ADR-0013 keeps document and profile authoring on the web). What the app
 * can do is say so plainly and let the person continue read-only.
 */
export default function Onboarding() {
  const router = useRouter();
  const { status, me } = useSession();
  if (status === 'signed_out') return <Redirect href="/sign-in" />;
  return (
    <Screen>
      <Title>Finish setting up on the web</Title>
      <Card>
        <Body>Hi {me?.fullName ?? 'there'}. Your account has not finished onboarding yet. Recommendations and prepared applications need your career profile and approved evidence, which you build on the JobPilot website.</Body>
        <Muted style={{ marginTop: 8 }}>On this phone you can already: review what has been prepared, track your folders and interviews, read notifications, and manage your consents and signed-in devices.</Muted>
      </Card>
      <Button title="Continue" onPress={() => router.replace('/(app)/(tabs)')} accessibilityHint="Opens the app; onboarding stays available on the web" />
    </Screen>
  );
}

import { Redirect } from 'expo-router';
import React from 'react';
import { useSession } from '@/auth/session';
import { LoadingState, Screen } from '@/ui/components';

/** Launch: wait for the stored key, then go where the session says. */
export default function Index() {
  const { status, onboarded } = useSession();
  if (status === 'loading') {
    return (
      <Screen scroll={false}>
        <LoadingState label="Opening JobPilot" />
      </Screen>
    );
  }
  if (status === 'signed_out') return <Redirect href="/sign-in" />;
  if (!onboarded) return <Redirect href="/onboarding" />;
  return <Redirect href="/(app)/(tabs)" />;
}

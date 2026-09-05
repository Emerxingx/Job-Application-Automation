import { Redirect, Stack } from 'expo-router';
import React from 'react';
import { useSession } from '@/auth/session';
import { useTheme } from '@/ui/theme';

/** Everything under here needs a session; without one the person is sent to sign in. */
export default function AppLayout() {
  const { status } = useSession();
  const t = useTheme();
  if (status === 'loading') return null;
  if (status === 'signed_out') return <Redirect href="/sign-in" />;
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: t.card }, headerTintColor: t.text, headerTitleStyle: { color: t.text }, contentStyle: { backgroundColor: t.bg } }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="jobs/[jobId]" options={{ title: 'Job' }} />
      <Stack.Screen name="matches/[matchId]" options={{ title: 'Why this match' }} />
      <Stack.Screen name="applications/[applicationId]" options={{ title: 'Application folder' }} />
      <Stack.Screen name="saved" options={{ title: 'Saved jobs' }} />
      <Stack.Screen name="profile/edit" options={{ title: 'Edit profile' }} />
      <Stack.Screen name="profile/privacy" options={{ title: 'Privacy & consent' }} />
      <Stack.Screen name="profile/devices" options={{ title: 'Signed-in devices' }} />
      <Stack.Screen name="profile/evidence" options={{ title: 'Career evidence' }} />
      <Stack.Screen name="profile/analytics" options={{ title: 'Your numbers' }} />
    </Stack>
  );
}

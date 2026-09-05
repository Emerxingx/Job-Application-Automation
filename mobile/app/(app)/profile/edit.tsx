import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { MeUpdate } from '@/api/client';
import { describeError } from '@/api/errors';
import { useSession } from '@/auth/session';
import { MODE_DESCRIPTIONS, MODE_LABELS } from '@/lib/format';
import { Button, Card, Muted, Screen, Title } from '@/ui/components';
import { FONT, SPACE, TOUCH, useTheme } from '@/ui/theme';

const MODES = ['recommend_only', 'prepare', 'review_submit'] as const;

/** The lightweight edits the mobile scope allows (PATCH /v1/me): name, city, headline, application mode. */
export default function EditProfile() {
  const t = useTheme();
  const router = useRouter();
  const { me, client, setMe } = useSession();
  const [fullName, setFullName] = useState(me?.fullName ?? '');
  const [city, setCity] = useState(me?.city ?? '');
  const [headline, setHeadline] = useState(me?.headline ?? '');
  const [mode, setMode] = useState<(typeof MODES)[number]>(me?.applicationMode ?? 'review_submit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const patch: MeUpdate = {};
      if (fullName.trim() !== me?.fullName) patch.fullName = fullName.trim();
      if ((city.trim() || null) !== (me?.city ?? null)) patch.city = city.trim() || null;
      if ((headline.trim() || null) !== (me?.headline ?? null)) patch.headline = headline.trim() || null;
      if (mode !== me?.applicationMode) patch.applicationMode = mode;
      if (Object.keys(patch).length === 0) {
        router.back();
        return;
      }
      setMe(await client.updateMe(patch));
      router.back();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const input = { minHeight: TOUCH, borderWidth: 1, borderColor: t.border, borderRadius: 10, paddingHorizontal: SPACE.md, color: t.text, fontSize: FONT.md, backgroundColor: t.card, marginBottom: SPACE.md } as const;
  return (
    <Screen>
      <Title>Edit profile</Title>
      <Muted style={{ marginBottom: SPACE.md }}>Your email is your sign-in and is changed on the web.</Muted>
      <Muted>Full name</Muted>
      <TextInput accessibilityLabel="Full name" value={fullName} onChangeText={setFullName} style={input} autoComplete="name" />
      <Muted>City</Muted>
      <TextInput accessibilityLabel="City" value={city} onChangeText={setCity} style={input} />
      <Muted>Headline</Muted>
      <TextInput accessibilityLabel="Headline" value={headline} onChangeText={setHeadline} style={input} maxLength={160} />
      <Title level={2}>How JobPilot applies</Title>
      <View accessibilityRole="radiogroup" accessibilityLabel="Application mode">
        {MODES.map((m) => (
          <Pressable key={m} accessibilityRole="radio" accessibilityState={{ checked: mode === m }} accessibilityLabel={`${MODE_LABELS[m]}: ${MODE_DESCRIPTIONS[m]}`} onPress={() => setMode(m)} style={{ minHeight: TOUCH, flexDirection: 'row', alignItems: 'flex-start', paddingVertical: SPACE.sm }}>
            <Text style={{ color: t.primary, fontSize: FONT.lg, width: 28 }}>{mode === m ? '◉' : '○'}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontSize: FONT.md, fontWeight: '600' }}>{MODE_LABELS[m]}</Text>
              <Text style={{ color: t.muted, fontSize: FONT.sm }}>{MODE_DESCRIPTIONS[m]}</Text>
            </View>
          </Pressable>
        ))}
      </View>
      <Card>
        <Muted>There is no automatic mode. Autonomous submission is not available to any account (ADR-0016); every submission is your own instruction after you have reviewed the application.</Muted>
      </Card>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: t.danger, marginBottom: SPACE.sm }}>
          {error}
        </Text>
      ) : null}
      <Button title="Save" onPress={save} busy={busy} />
      <Button title="Cancel" variant="secondary" onPress={() => router.back()} disabled={busy} />
    </Screen>
  );
}

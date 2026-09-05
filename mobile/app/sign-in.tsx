import { Redirect, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput } from 'react-native';
import { describeError } from '@/api/errors';
import { useSession } from '@/auth/session';
import { Body, Button, Card, Muted, Screen, Title } from '@/ui/components';
import { FONT, SPACE, TOUCH, useTheme } from '@/ui/theme';

/**
 * Sign in with the account's email and password. This mints a device key
 * (POST /v1/auth/sessions) kept in the platform's secure storage; the
 * password itself is never stored on the device. Identity-provider sign-in
 * (Supabase Auth, MFA) is a contract operation the server supports; the app
 * does not offer it yet because no provider is configured on any deployment
 * (INTEGRATION_REGISTER: IMPLEMENTED-NOT-VALIDATED) - stated, not hidden.
 */
export default function SignIn() {
  const t = useTheme();
  const router = useRouter();
  const { status, signIn, endedBecause, storage } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === 'signed_in') return <Redirect href="/" />;

  const submit = async () => {
    setError(null);
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    try {
      await signIn({ email, password });
      router.replace('/');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const input = { minHeight: TOUCH, borderWidth: 1, borderColor: t.border, borderRadius: 10, paddingHorizontal: SPACE.md, color: t.text, fontSize: FONT.md, backgroundColor: t.card, marginBottom: SPACE.md } as const;

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Title>Sign in to JobPilot</Title>
        <Muted style={{ marginBottom: SPACE.lg }}>Use the email and password of your JobPilot account. New here? Create your account on the web first - onboarding (profile, consents, your career evidence) happens there.</Muted>
        {endedBecause ? (
          <Card>
            <Body>{endedBecause}</Body>
          </Card>
        ) : null}
        <Text nativeID="email-label" style={styles.label}>
          <Muted>Email</Muted>
        </Text>
        <TextInput accessibilityLabel="Email" accessibilityLabelledBy="email-label" autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="username" value={email} onChangeText={setEmail} style={input} placeholder="you@example.com" placeholderTextColor={t.muted} editable={!busy} />
        <Text nativeID="password-label" style={styles.label}>
          <Muted>Password</Muted>
        </Text>
        <TextInput accessibilityLabel="Password" accessibilityLabelledBy="password-label" secureTextEntry autoComplete="current-password" textContentType="password" value={password} onChangeText={setPassword} style={input} onSubmitEditing={submit} returnKeyType="go" editable={!busy} />
        {error ? (
          <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={{ color: t.danger, marginBottom: SPACE.sm }}>
            {error}
          </Text>
        ) : null}
        <Button title="Sign in" onPress={submit} busy={busy} accessibilityHint="Signs this device in and keeps a device key in secure storage" />
        <Muted style={{ marginTop: SPACE.lg }}>{storage.description}</Muted>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({ label: { marginBottom: SPACE.xs } });

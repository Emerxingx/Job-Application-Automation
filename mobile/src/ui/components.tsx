/**
 * The handful of primitives every screen is built from. Each carries the
 * accessibility it needs by default - roles, labels, minimum touch size,
 * font scaling left on - so a screen cannot forget them.
 */
import React from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type PressableProps, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { describeError } from '@/api/errors';
import { formatAge } from '@/lib/format';
import { FONT, SPACE, TOUCH, useTheme } from './theme';

export function Screen({ children, scroll = true, refreshing, onRefresh, padded = true }: { children: React.ReactNode; scroll?: boolean; refreshing?: boolean; onRefresh?: () => void; padded?: boolean }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const style: StyleProp<ViewStyle> = [{ flex: 1, backgroundColor: t.bg }];
  const content = { padding: padded ? SPACE.lg : 0, paddingBottom: insets.bottom + SPACE.xl };
  if (!scroll) return <View style={[style, content]}>{children}</View>;
  return (
    <ScrollView style={style} contentContainerStyle={content} keyboardShouldPersistTaps="handled" refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} accessibilityLabel="Refresh" /> : undefined}>
      {children}
    </ScrollView>
  );
}

export function Title({ children, level = 1 }: { children: React.ReactNode; level?: 1 | 2 | 3 }) {
  const t = useTheme();
  const size = level === 1 ? FONT.xxl : level === 2 ? FONT.xl : FONT.lg;
  return (
    <Text accessibilityRole="header" style={{ color: t.text, fontSize: size, fontWeight: '700', marginBottom: SPACE.sm, marginTop: level === 1 ? 0 : SPACE.lg }}>
      {children}
    </Text>
  );
}

export function Body({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return <Text style={[{ color: t.text, fontSize: FONT.md, lineHeight: 22 }, style]}>{children}</Text>;
}

export function Muted({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return <Text style={[{ color: t.muted, fontSize: FONT.sm, lineHeight: 18 }, style]}>{children}</Text>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[{ backgroundColor: t.card, borderColor: t.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: SPACE.lg, marginBottom: SPACE.md }, style]}>{children}</View>;
}

export function Button({ title, onPress, variant = 'primary', disabled, busy, accessibilityHint, ...rest }: { title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; busy?: boolean } & Omit<PressableProps, 'onPress' | 'disabled' | 'children'>) {
  const t = useTheme();
  const off = disabled || busy;
  const bg = variant === 'primary' ? t.primary : variant === 'danger' ? t.danger : 'transparent';
  const fg = variant === 'primary' ? t.onPrimary : variant === 'danger' ? t.onPrimary : t.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: off, busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => ({ minHeight: TOUCH, justifyContent: 'center', alignItems: 'center', paddingHorizontal: SPACE.lg, borderRadius: 10, backgroundColor: bg, borderWidth: variant === 'secondary' ? 1 : 0, borderColor: t.primary, opacity: off ? 0.5 : pressed ? 0.8 : 1, marginTop: SPACE.sm })}
      {...rest}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontSize: FONT.md, fontWeight: '600' }}>{title}</Text>}
    </Pressable>
  );
}

export function Pill({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  const t = useTheme();
  const color = tone === 'success' ? t.success : tone === 'warning' ? t.warning : tone === 'danger' ? t.danger : t.text;
  return (
    <View style={{ alignSelf: 'flex-start', backgroundColor: t.pillBg, borderRadius: 999, paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs, marginRight: SPACE.sm, marginBottom: SPACE.xs }}>
      <Text style={{ color, fontSize: FONT.sm, fontWeight: '600' }}>{children}</Text>
    </View>
  );
}

export function Row({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }, style]}>{children}</View>;
}

/** A tappable list row with a chevron; the whole row is one accessible element. */
export function ListRow({ title, subtitle, meta, onPress, accessibilityHint }: { title: string; subtitle?: string; meta?: string; onPress?: () => void; accessibilityHint?: string }) {
  const t = useTheme();
  const inner = (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: TOUCH, paddingVertical: SPACE.md, borderBottomColor: t.border, borderBottomWidth: StyleSheet.hairlineWidth }}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontSize: FONT.md, fontWeight: '600' }}>{title}</Text>
        {subtitle ? <Text style={{ color: t.muted, fontSize: FONT.sm, marginTop: 2 }}>{subtitle}</Text> : null}
      </View>
      {meta ? <Text style={{ color: t.muted, fontSize: FONT.sm, marginLeft: SPACE.md }}>{meta}</Text> : null}
      {onPress ? (
        <Text style={{ color: t.muted, fontSize: FONT.lg, marginLeft: SPACE.sm }} accessibilityElementsHidden importantForAccessibility="no">
          ›
        </Text>
      ) : null}
    </View>
  );
  if (!onPress) return inner;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={[title, subtitle, meta].filter(Boolean).join(', ')} accessibilityHint={accessibilityHint ?? 'Opens details'} onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      {inner}
    </Pressable>
  );
}

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  const t = useTheme();
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={label} style={{ padding: SPACE.xl, alignItems: 'center' }}>
      <ActivityIndicator color={t.primary} />
      <Muted style={{ marginTop: SPACE.sm }}>{label}…</Muted>
    </View>
  );
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <Card>
      <Text accessibilityRole="header" style={{ fontSize: FONT.lg, fontWeight: '600', marginBottom: SPACE.xs }}>
        <Body>{title}</Body>
      </Text>
      {body ? <Muted>{body}</Muted> : null}
    </Card>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useTheme();
  return (
    <Card style={{ borderColor: t.danger }}>
      <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: t.danger, fontSize: FONT.md, fontWeight: '600' }}>
        {describeError(error)}
      </Text>
      {onRetry ? <Button title="Try again" variant="secondary" onPress={onRetry} /> : null}
    </Card>
  );
}

/** Shown above cached data: what is on screen is a saved copy, and how old. */
export function OfflineBanner({ storedAt }: { storedAt: string | null }) {
  const t = useTheme();
  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ backgroundColor: t.pillBg, borderRadius: 8, padding: SPACE.md, marginBottom: SPACE.md }}>
      <Text style={{ color: t.text, fontSize: FONT.sm }}>Offline. Showing a copy saved on this device{storedAt ? ` ${formatAge(storedAt)}` : ''}. Actions are unavailable until you are back online.</Text>
    </View>
  );
}

export function KeyValue({ label, value }: { label: string; value: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: SPACE.xs }} accessible accessibilityLabel={`${label}: ${typeof value === 'string' ? value : ''}`}>
      <Text style={{ color: t.muted, fontSize: FONT.sm, flex: 1 }}>{label}</Text>
      <Text style={{ color: t.text, fontSize: FONT.sm, flex: 2, textAlign: 'right' }}>{value}</Text>
    </View>
  );
}

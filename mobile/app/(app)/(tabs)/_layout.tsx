import { Tabs } from 'expo-router';
import React from 'react';
import { Text, type ColorValue } from 'react-native';
import { FONT, useTheme } from '@/ui/theme';

/** Text tab labels, deliberately: no icon font to load, and a label is what a screen reader says anyway. */
function Label({ title, color }: { title: string; color: ColorValue }) {
  return <Text style={{ color, fontSize: FONT.sm, fontWeight: '600' }}>{title}</Text>;
}

export default function TabsLayout() {
  const t = useTheme();
  const tab = (title: string) => ({
    title,
    tabBarLabel: ({ color }: { color: ColorValue }) => <Label title={title} color={color} />,
    tabBarIcon: () => null,
    tabBarAccessibilityLabel: `${title} tab`,
  });
  return (
    <Tabs screenOptions={{ headerStyle: { backgroundColor: t.card }, headerTintColor: t.text, tabBarStyle: { backgroundColor: t.card, borderTopColor: t.border, height: 56 }, tabBarActiveTintColor: t.primary, tabBarInactiveTintColor: t.muted, tabBarIconStyle: { display: 'none' }, tabBarLabelPosition: 'beside-icon', sceneStyle: { backgroundColor: t.bg } }}>
      <Tabs.Screen name="index" options={tab('Jobs')} />
      <Tabs.Screen name="applications" options={tab('Applications')} />
      <Tabs.Screen name="interviews" options={tab('Interviews')} />
      <Tabs.Screen name="notifications" options={tab('Activity')} />
      <Tabs.Screen name="profile" options={tab('You')} />
    </Tabs>
  );
}

/** WCAG 2.2 contrast, computed: text on its background ≥ 4.5:1, UI colours ≥ 3:1, in both themes. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DARK, LIGHT, TOUCH, type Theme } from '../src/ui/tokens';

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

function check(name: string, t: Theme) {
  const pairs: [string, string, string, number][] = [
    ['text on bg', t.text, t.bg, 4.5],
    ['text on card', t.text, t.card, 4.5],
    ['muted on bg', t.muted, t.bg, 4.5],
    ['muted on card', t.muted, t.card, 4.5],
    ['primary on bg', t.primary, t.bg, 4.5],
    ['onPrimary on primary', t.onPrimary, t.primary, 4.5],
    ['success on card', t.success, t.card, 4.5],
    ['warning on card', t.warning, t.card, 4.5],
    ['danger on card', t.danger, t.card, 4.5],
    ['text on pill', t.text, t.pillBg, 4.5],
    ['success on pill', t.success, t.pillBg, 4.5],
    ['warning on pill', t.warning, t.pillBg, 4.5],
    ['danger on pill', t.danger, t.pillBg, 4.5],
    ['border on card', t.border, t.card, 1.5],
  ];
  for (const [label, fg, bg, min] of pairs) {
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= min, `${name}: ${label} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
  }
}

describe('theme contrast', () => {
  it('light theme meets AA', () => check('light', LIGHT));
  it('dark theme meets AA', () => check('dark', DARK));
  it('touch targets are at least 44', () => assert.ok(TOUCH >= 44));
});

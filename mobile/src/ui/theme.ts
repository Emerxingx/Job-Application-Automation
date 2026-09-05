/** The hook; the tokens live in tokens.ts so tests can compute their contrast without React Native. */
import { useColorScheme } from 'react-native';
import { DARK, LIGHT, type Theme } from './tokens';

export { DARK, LIGHT, FONT, SPACE, TOUCH, type Theme } from './tokens';

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? DARK : LIGHT;
}

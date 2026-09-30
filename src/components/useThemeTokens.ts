import { useColorScheme } from 'react-native';
import { themes, type ThemeTokens } from '../lib/theme/tokens';

/** Resolves the light/dark token set for the current system appearance (SPEC.md section 5). */
export function useThemeTokens(): ThemeTokens {
  const scheme = useColorScheme();
  return themes[scheme === 'dark' ? 'dark' : 'light'];
}

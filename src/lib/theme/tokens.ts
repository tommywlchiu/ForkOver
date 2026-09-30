/**
 * Color tokens for light and dark mode. See SPEC.md section 10 (accessibility
 * baseline): every text/background pair here is checked for WCAG AA contrast
 * by contrast.test.ts. Claim/paid states also carry an icon name and label so
 * they never rely on color alone.
 */

export type ThemeName = 'light' | 'dark';

export type ThemeTokens = {
  background: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textMuted: string;
  primary: string;
  onPrimary: string;
  success: string;
  onSuccess: string;
  danger: string;
  onDanger: string;
  warningSurface: string;
  onWarningSurface: string;
};

export const themes: Record<ThemeName, ThemeTokens> = {
  light: {
    background: '#FFFFFF',
    surface: '#F2F2F7',
    surfaceAlt: '#E5E5EA',
    border: '#C7C7CC',
    text: '#0B0B0C',
    textMuted: '#48484F',
    primary: '#0B5FFF',
    onPrimary: '#FFFFFF',
    success: '#0B6B2E',
    onSuccess: '#FFFFFF',
    danger: '#A31510',
    onDanger: '#FFFFFF',
    warningSurface: '#FFF1C2',
    onWarningSurface: '#4A3900',
  },
  dark: {
    background: '#0B0B0C',
    surface: '#1C1C1E',
    surfaceAlt: '#2C2C2E',
    border: '#48484A',
    text: '#F5F5F7',
    textMuted: '#C7C7CD',
    primary: '#7DAAFF',
    onPrimary: '#00193F',
    success: '#7FDA9B',
    onSuccess: '#00280F',
    danger: '#FF8B85',
    onDanger: '#3D0300',
    warningSurface: '#4A3900',
    onWarningSurface: '#FFE187',
  },
};

/** Claim/paid states always pair an icon with a label; color is never the only signal (NFR-10). */
export type ClaimStateName = 'unclaimed' | 'claimed' | 'shared' | 'conflict' | 'assigned';

export const claimStateMeta: Record<ClaimStateName, { label: string; icon: string }> = {
  unclaimed: { label: 'Unclaimed', icon: 'circle' },
  claimed: { label: 'Claimed', icon: 'checkmark.circle.fill' },
  shared: { label: 'Shared', icon: 'person.2.fill' },
  conflict: { label: 'Conflict', icon: 'exclamationmark.triangle.fill' },
  assigned: { label: 'Assigned', icon: 'checkmark.seal.fill' },
};

/** Every (foreground, background) pair contrast.test.ts must check, per theme. */
export function contrastPairs(theme: ThemeTokens): [foreground: string, background: string, label: string][] {
  return [
    [theme.text, theme.background, 'text on background'],
    [theme.textMuted, theme.background, 'textMuted on background'],
    [theme.text, theme.surface, 'text on surface'],
    [theme.textMuted, theme.surface, 'textMuted on surface'],
    [theme.text, theme.surfaceAlt, 'text on surfaceAlt'],
    [theme.onPrimary, theme.primary, 'onPrimary on primary'],
    [theme.onSuccess, theme.success, 'onSuccess on success'],
    [theme.onDanger, theme.danger, 'onDanger on danger'],
    [theme.onWarningSurface, theme.warningSurface, 'onWarningSurface on warningSurface'],
  ];
}

/**
 * Shared, accessible controls: large tap targets (SPEC.md section 5), screen
 * reader labels and selected state instead of color alone (section 10).
 */
import { Pressable, StyleSheet, Text } from 'react-native';
import { useThemeTokens } from './useThemeTokens';

type ButtonProps = {
  testID: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityHint?: string;
};

export function PrimaryButton({ testID, label, onPress, disabled, accessibilityHint }: ButtonProps) {
  const theme = useThemeTokens();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: disabled ? theme.border : theme.primary, opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <Text style={[styles.label, { color: disabled ? theme.textMuted : theme.onPrimary }]}>{label}</Text>
    </Pressable>
  );
}

export function SecondaryButton({ testID, label, onPress, disabled, accessibilityHint }: ButtonProps) {
  const theme = useThemeTokens();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [styles.base, styles.secondary, { borderColor: theme.primary, opacity: pressed ? 0.7 : 1 }]}
    >
      <Text style={[styles.label, { color: theme.primary }]}>{label}</Text>
    </Pressable>
  );
}

export function Chip({
  testID,
  label,
  selected,
  onPress,
  accessibilityLabel,
}: {
  testID: string;
  label: string;
  selected: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  const theme = useThemeTokens();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? theme.primary : theme.surface,
          borderColor: selected ? theme.primary : theme.border,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <Text style={{ color: selected ? theme.onPrimary : theme.text, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  secondary: { borderWidth: 1.5, backgroundColor: 'transparent' },
  label: { fontSize: 16, fontWeight: '700' },
  chip: {
    minHeight: 40,
    borderRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
});

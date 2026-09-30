/**
 * AI consent sheet (SPEC.md sections 2.2 and 9). Shown before the first
 * scan; nothing is pre-selected. "Allow" grants consent and lets the caller
 * proceed to Scan; "Enter manually instead" declines and never sends a photo
 * anywhere.
 */
import { Modal, StyleSheet, Text, View } from 'react-native';
import { useThemeTokens } from './useThemeTokens';
import { PrimaryButton, SecondaryButton } from './Buttons';

export function ConsentSheet({
  visible,
  onAllow,
  onManual,
}: {
  visible: boolean;
  onAllow: () => void;
  onManual: () => void;
}) {
  const theme = useThemeTokens();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onManual}>
      <View style={styles.backdrop}>
        <View
          style={[styles.sheet, { backgroundColor: theme.background, borderColor: theme.border }]}
          accessibilityViewIsModal
          accessibilityRole="alert"
        >
          <Text style={[styles.title, { color: theme.text }]}>Read this receipt with AI?</Text>
          <Text style={[styles.body, { color: theme.textMuted }]}>
            ForkOver sends your receipt photo to Anthropic&apos;s Claude AI to read the items, tax, and
            tip. You can turn this off later in Settings.
          </Text>
          <PrimaryButton testID="consent-allow-button" label="Allow" onPress={onAllow} />
          <SecondaryButton testID="consent-manual-button" label="Enter manually instead" onPress={onManual} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { padding: 24, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: StyleSheet.hairlineWidth, gap: 12 },
  title: { fontSize: 20, fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 21 },
});

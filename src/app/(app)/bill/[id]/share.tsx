/**
 * Share (SPEC.md sections 2.2 step 5, 4): QR code for the bill link, copy
 * link, native share sheet. "Send in app" needs member accounts and search
 * (M4), so it stays a disabled placeholder for now.
 */
import * as Clipboard from 'expo-clipboard';
import { createURL } from 'expo-linking';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Share as RNShare, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { PrimaryButton, SecondaryButton } from '../../../../components/Buttons';
import { useThemeTokens } from '../../../../components/useThemeTokens';
import { useBillStore } from '../../../../state/bill';

export default function ShareScreen() {
  const theme = useThemeTokens();
  const { id: billId } = useLocalSearchParams<{ id: string }>();
  const bill = useBillStore((s) => s.bills[billId]);
  const markSent = useBillStore((s) => s.markSent);
  const [copied, setCopied] = useState(false);

  const link = useMemo(() => createURL(`b/${billId}`), [billId]);

  if (!bill) return <Redirect href="/" />;

  const recordSent = () => {
    if (bill.sentAt === null) markSent(bill.id);
  };

  const onCopy = async () => {
    await Clipboard.setStringAsync(link);
    recordSent();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const onShare = async () => {
    try {
      await RNShare.share({ message: link });
      recordSent();
    } catch {
      // Sharing isn't available on this platform (e.g. some web browsers); copy still works.
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <Text style={[styles.title, { color: theme.text }]}>Share this bill</Text>

      <View testID="qr-code" style={styles.qrWrap} accessibilityLabel="QR code for the bill link">
        <QRCode value={link} size={220} />
      </View>

      <Text style={{ color: theme.textMuted, textAlign: 'center' }} numberOfLines={1}>
        {link}
      </Text>
      {copied && (
        <Text testID="copy-confirmation" style={{ color: theme.success, textAlign: 'center' }}>
          Link copied
        </Text>
      )}

      <View style={styles.actions}>
        <SecondaryButton testID="copy-link-button" label="Copy link" onPress={onCopy} />
        <SecondaryButton testID="share-link-button" label="Share link" onPress={onShare} />
        <SecondaryButton testID="send-in-app-button" label="Send in app (coming soon)" onPress={() => {}} disabled />
      </View>

      <PrimaryButton
        testID="go-to-bill-button"
        label="View bill"
        onPress={() => {
          recordSent();
          router.replace({ pathname: '/bill/[id]', params: { id: bill.id } });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, paddingTop: 60, gap: 12, alignItems: 'stretch' },
  title: { fontSize: 24, fontWeight: '800', textAlign: 'center', marginBottom: 8 },
  qrWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 16 },
  actions: { gap: 10, marginTop: 16 },
});

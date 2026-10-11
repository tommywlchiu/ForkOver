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
import { NoConnectionBanner } from '../../../../components/NoConnectionBanner';
import { SyncStatusBanner } from '../../../../components/SyncStatusBanner';
import { useThemeTokens } from '../../../../components/useThemeTokens';
import { useBillStore } from '../../../../state/bill';
import { useResolvedBill } from '../../../../state/useResolvedBill';

export default function ShareScreen() {
  const theme = useThemeTokens();
  const { id: billId } = useLocalSearchParams<{ id: string }>();
  // `useResolvedBill` handles the local-id -> real-id rekey fallback and offline gating
  // uniformly across every bill screen (code review on PR #31) - this screen used to read
  // `s.bills[billId]` directly, with neither.
  const { bill, controlsDisabled, syncError, dismissSyncError, notSynced, retrySync } = useResolvedBill(billId);
  const markSent = useBillStore((s) => s.markSent);
  const [copied, setCopied] = useState(false);

  // `bill?.id` (the real, resolved id), not the raw route param: once the rekey fallback above
  // resolves a scan's draft bill to its real server id, the link must point at that id too.
  const link = useMemo(() => createURL(`b/${bill?.id ?? billId}`), [bill?.id, billId]);

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
      <NoConnectionBanner />
      <SyncStatusBanner notSynced={notSynced} retrySync={retrySync} syncError={syncError} dismissSyncError={dismissSyncError} />

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
        <SecondaryButton testID="copy-link-button" label="Copy link" onPress={onCopy} disabled={controlsDisabled} />
        <SecondaryButton testID="share-link-button" label="Share link" onPress={onShare} disabled={controlsDisabled} />
        <SecondaryButton testID="send-in-app-button" label="Send in app (coming soon)" onPress={() => {}} disabled />
      </View>

      <PrimaryButton
        testID="go-to-bill-button"
        label="View bill"
        disabled={controlsDisabled}
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

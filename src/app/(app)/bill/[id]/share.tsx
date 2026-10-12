/**
 * Share (SPEC.md sections 2.2 step 5, 4, 8.2): QR code for the bill link, copy link, native share
 * sheet, and "Send in app" - username search (already merged, `UsernameSearch`) wired to the
 * `invite_bill_member` RPC (M4 in-app-sending task). Selecting a result only calls the RPC; it
 * doesn't update this screen's people list itself - the new `bill_people` row reaches it through
 * the realtime subscription every bill screen already has via `useResolvedBill`, the same path
 * any other change arrives through (confirmed against a real local Supabase stack, not assumed -
 * see the migration's own comment).
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
import { UsernameSearch, type UsernameSearchResult } from '../../../../components/UsernameSearch';
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
  const invitePerson = useBillStore((s) => s.invitePerson);
  const [copied, setCopied] = useState(false);
  const [inviteStatus, setInviteStatus] = useState<{ username: string; state: 'sending' | 'sent' | 'error' } | null>(null);

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

  const onInvite = async (user: UsernameSearchResult) => {
    setInviteStatus({ username: user.username, state: 'sending' });
    const error = await invitePerson(bill.id, user.id);
    if (error) {
      setInviteStatus({ username: user.username, state: 'error' });
      return;
    }
    recordSent();
    setInviteStatus({ username: user.username, state: 'sent' });
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
      </View>

      <View testID="send-in-app-section" style={styles.inviteSection}>
        <Text style={[styles.sectionLabel, { color: theme.text }]}>Send in app</Text>
        {controlsDisabled ? (
          <Text style={{ color: theme.textMuted }}>Reconnect to search and invite.</Text>
        ) : (
          <UsernameSearch onSelect={onInvite} />
        )}
        {inviteStatus?.state === 'sending' && (
          <Text testID="invite-sending" style={{ color: theme.textMuted }}>
            Inviting @{inviteStatus.username}…
          </Text>
        )}
        {inviteStatus?.state === 'sent' && (
          <Text testID="invite-confirmation" style={{ color: theme.success }}>
            Invited @{inviteStatus.username}
          </Text>
        )}
        {inviteStatus?.state === 'error' && (
          <Text testID="invite-error" style={{ color: theme.danger }}>
            Could not invite @{inviteStatus.username}. Try again.
          </Text>
        )}
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
  inviteSection: { gap: 8, marginTop: 16 },
  sectionLabel: { fontSize: 16, fontWeight: '700' },
});

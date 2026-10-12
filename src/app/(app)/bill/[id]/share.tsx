/**
 * Share (SPEC.md sections 2.2 step 5, 4, 8.2): QR code for the bill link, copy link, native share
 * sheet, and "Send in app" - username search (already merged, `UsernameSearch`) wired to the
 * `invite_bill_member` RPC (M4 in-app-sending task). Selecting a result only calls the RPC; it
 * doesn't update this screen's people list itself - the new `bill_people` row reaches it through
 * the realtime subscription every bill screen already has via `useResolvedBill`, the same path
 * any other change arrives through (confirmed against a real local Supabase stack, not assumed -
 * see `inviteBillMember`'s own doc, src/data/supabaseBillStore.ts).
 *
 * The invite section is payer-only (`isPayer`) and gated on the bill actually being synced to the
 * server (`notSynced`), not just online (`controlsDisabled`): a bill whose promotion failed stays
 * on a local draft id the server has never heard of even while the device is online, and the RPC
 * needs a real bill id (code review). The actionable surfaces for automation here are
 * `UsernameSearch`'s own `username-search-input`/`username-search-result-<id>` testIDs, not a
 * single "send in app" button anymore - there's no one tap that starts the flow, searching and
 * selecting are the same action.
 */
import * as Clipboard from 'expo-clipboard';
import { createURL } from 'expo-linking';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { Share as RNShare, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { PrimaryButton, SecondaryButton } from '../../../../components/Buttons';
import { NoConnectionBanner } from '../../../../components/NoConnectionBanner';
import { SyncStatusBanner } from '../../../../components/SyncStatusBanner';
import { useThemeTokens } from '../../../../components/useThemeTokens';
import { UsernameSearch, type UsernameSearchResult } from '../../../../components/UsernameSearch';
import { useBillStore } from '../../../../state/bill';
import { useSessionStore } from '../../../../state/session';
import { useResolvedBill } from '../../../../state/useResolvedBill';

type InviteState = 'sending' | 'sent' | 'already-member' | 'error';
/** Keyed by the invited user's id, not a single shared slot - two concurrent invites (one slow,
 *  one fast) must each keep showing their own outcome, not whichever RPC happens to resolve last
 *  (code review). */
type InviteStatuses = Record<string, { username: string; state: InviteState; message?: string }>;

export default function ShareScreen() {
  const theme = useThemeTokens();
  const { id: billId } = useLocalSearchParams<{ id: string }>();
  // `useResolvedBill` handles the local-id -> real-id rekey fallback and offline gating
  // uniformly across every bill screen (code review on PR #31) - this screen used to read
  // `s.bills[billId]` directly, with neither.
  const { bill, controlsDisabled, syncError, dismissSyncError, notSynced, retrySync } = useResolvedBill(billId);
  const markSent = useBillStore((s) => s.markSent);
  const invitePerson = useBillStore((s) => s.invitePerson);
  const sessionUserId = useSessionStore((s) => s.userId);
  const [copied, setCopied] = useState(false);
  const [inviteStatuses, setInviteStatuses] = useState<InviteStatuses>({});
  // Guards against double-tapping the same result while its invite is still in flight (code
  // review) - a ref, not state, since it's never rendered itself.
  const inFlightInvites = useRef<Set<string>>(new Set());

  // `bill?.id` (the real, resolved id), not the raw route param: once the rekey fallback above
  // resolves a scan's draft bill to its real server id, the link must point at that id too.
  const link = useMemo(() => createURL(`b/${bill?.id ?? billId}`), [bill?.id, billId]);

  if (!bill) return <Redirect href="/" />;

  // Only the payer can invite (SPEC 8.2 "Payer only") - nothing else in `src/app` gates a screen
  // by viewer identity yet, so this has to check it itself rather than assume a route guard
  // exists upstream (code review). `payerUserId` is the payer's raw auth user id, not the
  // `bill_people` id `bill.payerId` resolves to post-promotion.
  const isPayer = !!bill.payerUserId && sessionUserId === bill.payerUserId;
  // The invite RPC needs a real, server-side bill id - a bill still on its local draft id
  // (promotion never completed, e.g. a network blip) can't be invited to even while the device
  // is online, so this has to be its own check, not just `controlsDisabled` (code review).
  const inviteBlocked = controlsDisabled || notSynced;

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
    if (inFlightInvites.current.has(user.id)) return; // already inviting this exact person
    inFlightInvites.current.add(user.id);
    setInviteStatuses((prev) => ({ ...prev, [user.id]: { username: user.username, state: 'sending' } }));
    try {
      const { error, alreadyMember } = await invitePerson(bill.id, user.id);
      if (error) {
        // Surface the real reason (code review: three layers were plumbing `error` through only
        // to discard it for a single generic message everywhere).
        setInviteStatuses((prev) => ({ ...prev, [user.id]: { username: user.username, state: 'error', message: error } }));
        return;
      }
      if (alreadyMember) {
        // Nothing actually changed - don't claim a fresh invite happened (code review).
        setInviteStatuses((prev) => ({ ...prev, [user.id]: { username: user.username, state: 'already-member' } }));
        return;
      }
      recordSent();
      setInviteStatuses((prev) => ({ ...prev, [user.id]: { username: user.username, state: 'sent' } }));
    } finally {
      inFlightInvites.current.delete(user.id);
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
      </View>

      {isPayer && (
        <View testID="send-in-app-section" style={styles.inviteSection}>
          <Text style={[styles.sectionLabel, { color: theme.text }]}>Send in app</Text>
          {inviteBlocked ? (
            <Text style={{ color: theme.textMuted }}>
              {notSynced ? "Still syncing this bill - try again once it's synced." : 'Reconnect to search and invite.'}
            </Text>
          ) : (
            <UsernameSearch onSelect={onInvite} excludeUserId={sessionUserId ?? undefined} />
          )}
          {Object.entries(inviteStatuses).map(([userId, status]) => (
            <Text
              key={userId}
              testID={`invite-status-${userId}`}
              style={{ color: status.state === 'sent' ? theme.success : status.state === 'error' ? theme.danger : theme.textMuted }}
            >
              {status.state === 'sending' && `Inviting @${status.username}…`}
              {status.state === 'sent' && `Invited @${status.username}`}
              {status.state === 'already-member' && `@${status.username} is already on this bill`}
              {status.state === 'error' && `Could not invite @${status.username}: ${status.message ?? 'try again.'}`}
            </Text>
          ))}
        </View>
      )}

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

/**
 * Public bill link (SPEC.md sections 2.3, 4): join (guests), claim, pay, or a closed-bill
 * summary. Native and web - this route sits outside both the `(auth)` and `(app)` groups (the
 * root layout, src/app/_layout.tsx, just renders whichever matched), so it never hits the
 * sign-in gate the rest of the app does.
 *
 * Resolving `token` to a bill has two paths (see supabaseBillStore.ts's own doc on why):
 * - Already a member (the payer revisiting their own link, or a guest/member reopening it in the
 *   same browser/app - their anonymous or real session persists, SPEC 8.2): a plain, RLS-gated
 *   select by `share_token` finds the bill directly, closed or not (`fetchBillByShareTokenIfMember`).
 * - Not yet a member: `join_bill` (security definer) is the only way to resolve the token at all.
 *   It needs a display name - prompted for guests only (SPEC 2.3 step 2); a signed-in caller who
 *   isn't a member yet joins silently with their own profile name, no prompt, since nothing in
 *   SPEC 2.3 asks a *member* to pick a name. If the bill doesn't exist, or is closed and the
 *   caller was never a member of it, `join_bill` raises - mapped to the two different empty
 *   states below rather than one generic error, since "this link is wrong" and "this bill is
 *   closed" call for different messages.
 *
 * Claiming here always acts for "self" (the resolved person id) - there is no person-switcher
 * like the payer's bill screen; "claim for anyone" is a payer-only M5 control (SPEC 2.4).
 */
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Chip, PrimaryButton } from '../../components/Buttons';
import { NoConnectionBanner } from '../../components/NoConnectionBanner';
import { SyncStatusBanner } from '../../components/SyncStatusBanner';
import { useThemeTokens } from '../../components/useThemeTokens';
import {
  fetchBillByShareTokenIfMember,
  findOwnPersonId,
  joinBillByToken,
  type JoinBillError,
} from '../../data/supabaseBillStore';
import { buildVenmoPayLink } from '../../lib/pay/venmo';
import { formatMoney } from '../../lib/money/format';
import { claimStateMeta } from '../../lib/theme/tokens';
import { analytics } from '../../state/analytics';
import { useBillStore } from '../../state/bill';
import { ensureSession, useSessionStore } from '../../state/session';
import { useResolvedBill } from '../../state/useResolvedBill';

type Phase = 'loading' | 'joining' | 'name-prompt' | 'not-found' | 'closed-unavailable' | 'error' | 'ready';

export default function ClaimLinkScreen() {
  const theme = useThemeTokens();
  const { token } = useLocalSearchParams<{ token: string }>();

  const loadBill = useBillStore((s) => s.loadBill);
  const toggleMine = useBillStore((s) => s.toggleMine);
  const toggleShared = useBillStore((s) => s.toggleShared);
  const getSplit = useBillStore((s) => s.getSplit);
  const getResolvedItems = useBillStore((s) => s.getResolvedItems);
  const claimFor = useBillStore((s) => s.claimFor);

  const [phase, setPhase] = useState<Phase>('loading');
  const [billId, setBillId] = useState<string | null>(null);
  const [personId, setPersonId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const hasRecordedFirstClaim = useRef(false);

  const { bill, controlsDisabled, syncError, dismissSyncError, notSynced, retrySync } = useResolvedBill(billId ?? '');

  async function attemptJoin(displayName: string) {
    if (!token) return;
    const trimmed = displayName.trim();
    if (trimmed.length < 1 || trimmed.length > 30) {
      setJoinError('Enter a name, 1 to 30 characters.');
      setPhase('name-prompt');
      return;
    }
    setPhase('joining');
    const result = await joinBillByToken(token, trimmed);
    if (!result.ok) {
      applyJoinError(result.error);
      return;
    }
    loadBill(result.bill);
    setBillId(result.bill.id);
    setPersonId(result.personId);
    setJoinError(null);
    setPhase('ready');
    analytics.record('claim_page_opened');
  }

  function applyJoinError(error: JoinBillError) {
    if (error.reason === 'not_found') {
      setPhase('not-found');
    } else if (error.reason === 'closed') {
      setPhase('closed-unavailable');
    } else {
      setJoinError(error.message);
      setPhase('name-prompt');
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) return;
      try {
        const { userId, isAnonymous } = await ensureSession();
        const existing = await fetchBillByShareTokenIfMember(token);
        if (cancelled) return;
        if (existing) {
          const ownId = await findOwnPersonId(existing.id, userId);
          if (cancelled) return;
          if (!ownId) {
            setPhase('error');
            return;
          }
          loadBill(existing);
          setBillId(existing.id);
          setPersonId(ownId);
          setPhase('ready');
          analytics.record('claim_page_opened');
          return;
        }
        if (isAnonymous) {
          setPhase('name-prompt');
          return;
        }
        // Signed-in, not yet a member: join silently with the caller's own profile name (SPEC
        // 2.3 step 2 - the name prompt is guest-only).
        const session = useSessionStore.getState();
        await attemptJoin(session.displayName ?? session.username ?? 'Member');
      } catch {
        if (!cancelled) setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- attemptJoin/loadBill are stable store actions; re-running this on every render would re-join on every keystroke elsewhere.
  }, [token]);

  if (phase === 'loading' || phase === 'joining') {
    return (
      <View style={[styles.centered, { backgroundColor: theme.background }]}>
        <ActivityIndicator testID="claim-link-loading" color={theme.primary} />
      </View>
    );
  }

  if (phase === 'not-found') {
    return (
      <View style={[styles.centered, { backgroundColor: theme.background }]}>
        <View style={styles.centeredBox}>
          <Text testID="bill-not-found" style={[styles.message, { color: theme.text }]}>
            This link isn&apos;t valid. Double-check it with whoever sent it.
          </Text>
        </View>
      </View>
    );
  }

  if (phase === 'closed-unavailable') {
    return (
      <View style={[styles.centered, { backgroundColor: theme.background }]}>
        <View style={styles.centeredBox}>
          <Text testID="bill-closed-unavailable" style={[styles.message, { color: theme.text }]}>
            This bill is closed, and you weren&apos;t one of the people on it.
          </Text>
        </View>
      </View>
    );
  }

  if (phase === 'error') {
    return (
      <View style={[styles.centered, { backgroundColor: theme.background }]}>
        <View style={styles.centeredBox}>
          <Text testID="claim-link-error" style={[styles.message, { color: theme.danger }]}>
            Something went wrong opening this bill. Try again.
          </Text>
        </View>
      </View>
    );
  }

  if (phase === 'name-prompt') {
    return (
      <View style={[styles.centered, { backgroundColor: theme.background }]}>
        <View style={styles.centeredBox}>
          <Text style={[styles.centeredTitle, { color: theme.text }]}>What&apos;s your name?</Text>
          <Text style={[styles.message, { color: theme.textMuted, marginBottom: 16 }]}>
            So everyone on this bill knows who claimed what.
          </Text>
          <TextInput
            testID="join-name-input"
            value={name}
            onChangeText={setName}
            placeholder="Name"
            placeholderTextColor={theme.textMuted}
            accessibilityLabel="Your name"
            maxLength={30}
            style={[styles.nameInput, { color: theme.text, borderColor: theme.border }]}
          />
          {joinError && (
            <Text testID="join-error" style={{ color: theme.danger, marginBottom: 8 }}>
              {joinError}
            </Text>
          )}
          <PrimaryButton testID="join-button" label="Join bill" onPress={() => attemptJoin(name)} />
        </View>
      </View>
    );
  }

  // phase === 'ready'
  if (!bill || !personId) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.background }]}>
        <ActivityIndicator testID="claim-link-loading" color={theme.primary} />
      </View>
    );
  }

  const isClosed = bill.status === 'closed';
  const resolvedItems = getResolvedItems(bill.id);
  const resolvedById = new Map(resolvedItems.map((r) => [r.itemId, r]));
  const peopleById = new Map(bill.people.map((p) => [p.id, p.name]));
  const nameFor = (id: string) => (id === bill.payerId ? `${peopleById.get(id) ?? 'the payer'} (payer)` : peopleById.get(id) ?? id);
  const split = getSplit(bill.id);
  const myShare = split?.ok ? split.shares.find((s) => s.personId === personId) : undefined;

  const onToggleMine = (itemId: string) => {
    toggleMine(bill.id, itemId, personId);
    if (!hasRecordedFirstClaim.current) {
      hasRecordedFirstClaim.current = true;
      analytics.record('first_claim');
    }
  };
  const onToggleShared = (itemId: string) => {
    toggleShared(bill.id, itemId, personId);
    if (!hasRecordedFirstClaim.current) {
      hasRecordedFirstClaim.current = true;
      analytics.record('first_claim');
    }
  };

  // Payments/paid-marks (SPEC 6.4) are a payer-only M5 control, not read by StoredBill yet - the
  // remaining balance is simply the person's total until that lands.
  const remainingCents = myShare?.totalCents ?? 0;
  const canPayOnVenmo = !isClosed && bill.currency === 'USD' && !!bill.payerVenmoUsername && personId !== bill.payerId && remainingCents > 0;
  const venmoLink = canPayOnVenmo
    ? buildVenmoPayLink({ username: bill.payerVenmoUsername as string, amountCents: remainingCents, note: `ForkOver: ${bill.title}` })
    : null;

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <NoConnectionBanner />
      <SyncStatusBanner notSynced={notSynced} retrySync={retrySync} syncError={syncError} dismissSyncError={dismissSyncError} />

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: theme.text }]}>{bill.title}</Text>
        {isClosed && (
          <Text testID="closed-summary-banner" style={{ color: theme.textMuted, marginBottom: 8 }}>
            This bill is closed. Summary only.
          </Text>
        )}

        <Text style={[styles.sectionTitle, { color: theme.text }]}>Items</Text>
        {bill.items.map((item) => {
          const resolved = resolvedById.get(item.id);
          const state = resolved?.state ?? 'unclaimed';
          const meta = claimStateMeta[state];
          const holders = resolved && resolved.assignedTo.length > 0 ? resolved.assignedTo.map(nameFor).join(', ') : null;
          const mode = claimFor(bill.id, item.id, personId);
          const priceLabel = formatMoney(item.priceCents, bill.currency, 'en-US');

          return (
            <View
              key={item.id}
              style={[styles.itemRow, { borderColor: theme.border }]}
              accessibilityLabel={`${item.name}, ${priceLabel}, ${holders ? `claimed by ${holders}` : 'unclaimed'}`}
            >
              <View style={styles.itemInfo}>
                <Text style={{ color: theme.text, fontWeight: '600' }}>{item.name}</Text>
                <Text style={{ color: theme.textMuted }}>{priceLabel}</Text>
                <Text style={{ color: theme.textMuted, fontSize: 13 }}>
                  {meta.label}
                  {holders ? `: ${holders}` : ''}
                </Text>
              </View>
              {!isClosed && (
                <>
                  <Chip
                    testID={`claim-item-${item.id}`}
                    label="Mine"
                    selected={mode === 'mine'}
                    disabled={controlsDisabled}
                    accessibilityLabel={`Claim ${item.name} as mine`}
                    onPress={() => onToggleMine(item.id)}
                  />
                  <Chip
                    testID={`share-item-${item.id}`}
                    label="Share"
                    selected={mode === 'shared'}
                    disabled={controlsDisabled}
                    accessibilityLabel={`Claim ${item.name} as shared`}
                    onPress={() => onToggleShared(item.id)}
                  />
                </>
              )}
            </View>
          );
        })}
      </ScrollView>

      {myShare && (
        <View style={[styles.totalsCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Pressable
            testID="totals-breakdown-toggle"
            accessibilityRole="button"
            accessibilityLabel={expanded ? 'Hide breakdown' : 'Show breakdown'}
            onPress={() => setExpanded((v) => !v)}
            style={styles.totalsRow}
          >
            <Text style={{ color: theme.text, fontWeight: '700', fontSize: 16 }}>Your total</Text>
            <Text testID="my-total" style={{ color: theme.text, fontWeight: '800', fontSize: 16 }}>
              {formatMoney(myShare.totalCents, bill.currency, 'en-US')}
            </Text>
          </Pressable>

          {expanded && (
            <View testID="totals-breakdown" style={styles.breakdown}>
              <BreakdownLine label="Items" cents={myShare.itemsCents} currency={bill.currency} color={theme.textMuted} />
              <BreakdownLine label="Discount" cents={-myShare.discountCents} currency={bill.currency} color={theme.textMuted} />
              <BreakdownLine label="Tax" cents={myShare.taxCents} currency={bill.currency} color={theme.textMuted} />
              <BreakdownLine label="Tip" cents={myShare.tipCents} currency={bill.currency} color={theme.textMuted} />
              <BreakdownLine label="Fees" cents={myShare.feesCents} currency={bill.currency} color={theme.textMuted} />
            </View>
          )}

          {venmoLink && (
            <PrimaryButton
              testID="pay-venmo-button"
              label={`Pay ${formatMoney(remainingCents, bill.currency, 'en-US')} on Venmo`}
              disabled={controlsDisabled}
              onPress={() => {
                void Linking.openURL(venmoLink);
              }}
            />
          )}
        </View>
      )}
    </View>
  );
}

function BreakdownLine({ label, cents, currency, color }: { label: string; cents: number; currency: string; color: string }) {
  return (
    <View style={styles.breakdownRow}>
      <Text style={{ color }}>{label}</Text>
      <Text style={{ color }}>{formatMoney(cents, currency, 'en-US')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  // A plain View with a fixed width, not a bare Text/TextInput centered by a shrink-to-fit flex
  // parent: RN Web sizes an unconstrained Text to its own (unwrapped) content width before
  // wrapping, which both overflows a narrow screen and defeats centering (it centers the
  // oversized box, not the wrapped text within it).
  centeredBox: { width: 320, maxWidth: '100%', alignItems: 'center' },
  content: { padding: 20, paddingTop: 60, paddingBottom: 140 },
  title: { fontSize: 24, fontWeight: '800', marginBottom: 4 },
  centeredTitle: { fontSize: 24, fontWeight: '800', marginBottom: 4, textAlign: 'center', width: '100%' },
  message: { fontSize: 16, textAlign: 'center', width: '100%' },
  sectionTitle: { fontSize: 18, fontWeight: '700', marginTop: 12, marginBottom: 8 },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 10 },
  itemInfo: { flex: 1 },
  nameInput: { width: '100%', borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12, textAlign: 'center' },
  totalsCard: { borderTopWidth: 1, padding: 16, gap: 8 },
  totalsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  breakdown: { gap: 4, paddingTop: 4 },
  breakdownRow: { flexDirection: 'row', justifyContent: 'space-between' },
});

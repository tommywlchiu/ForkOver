/**
 * Home (SPEC.md section 2.2, step 1): "I paid" and "Shared with me" tabs,
 * "Scan receipt" (gated by AI consent) and "Enter manually".
 */
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { ConsentSheet } from '../../components/ConsentSheet';
import { PrimaryButton, SecondaryButton } from '../../components/Buttons';
import { useThemeTokens } from '../../components/useThemeTokens';
import { formatMoney } from '../../lib/money/format';
import { useBillStore } from '../../state/bill';
import { FREE_SCANS_PER_MONTH, useSessionStore } from '../../state/session';
import type { StoredBill } from '../../data/localBillStore';

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

export default function Home() {
  const theme = useThemeTokens();
  const userId = useSessionStore((s) => s.userId)!;
  const username = useSessionStore((s) => s.username)!;
  const aiConsentAt = useSessionStore((s) => s.aiConsentAt);
  const recordAiConsent = useSessionStore((s) => s.recordAiConsent);
  const scansUsedThisMonth = useSessionStore((s) => s.scansUsedThisMonth);

  const bills = useBillStore((s) => s.bills);
  const createDraftBill = useBillStore((s) => s.createDraftBill);
  const startManualEntry = useBillStore((s) => s.startManualEntry);
  const getSplit = useBillStore((s) => s.getSplit);

  const [tab, setTab] = useState<'mine' | 'shared'>('mine');
  const [consentVisible, setConsentVisible] = useState(false);

  const payer = useMemo(() => ({ id: userId, name: capitalize(username) }), [userId, username]);
  const myBills = useMemo(
    () => Object.values(bills).filter((bill) => bill.payerId === userId).sort((a, b) => b.createdAt - a.createdAt),
    [bills, userId],
  );
  const scansLeft = Math.max(0, FREE_SCANS_PER_MONTH - scansUsedThisMonth);

  const goManual = () => {
    const billId = createDraftBill(payer);
    startManualEntry(billId);
    router.push({ pathname: '/bill/[id]/review', params: { id: billId } });
  };

  const startScanFlow = () => {
    if (aiConsentAt === null) {
      setConsentVisible(true);
      return;
    }
    router.push('/scan');
  };

  const renderBill = ({ item }: { item: StoredBill }) => {
    const split = getSplit(item.id);
    return (
      <Pressable
        testID={`bill-row-${item.id}`}
        accessibilityRole="button"
        accessibilityLabel={`${item.title}, ${item.status}`}
        onPress={() =>
          router.push(
            item.status === 'draft'
              ? { pathname: '/bill/[id]/review', params: { id: item.id } }
              : { pathname: '/bill/[id]', params: { id: item.id } },
          )
        }
        style={[styles.billRow, { borderColor: theme.border }]}
      >
        <View>
          <Text style={[styles.billTitle, { color: theme.text }]}>{item.title}</Text>
          <Text style={{ color: theme.textMuted }}>{item.status}</Text>
        </View>
        {split?.ok && (
          <Text style={{ color: theme.text, fontWeight: '700' }}>
            {formatMoney(split.totals.grandTotalCents, item.currency, 'en-US')}
          </Text>
        )}
      </Pressable>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <Text style={[styles.header, { color: theme.text }]}>ForkOver</Text>

      <View style={styles.tabs}>
        <Pressable
          testID="tab-i-paid"
          accessibilityRole="tab"
          accessibilityState={{ selected: tab === 'mine' }}
          onPress={() => setTab('mine')}
          style={[styles.tab, tab === 'mine' && { borderBottomColor: theme.primary, borderBottomWidth: 2 }]}
        >
          <Text style={{ color: tab === 'mine' ? theme.text : theme.textMuted, fontWeight: '700' }}>I paid</Text>
        </Pressable>
        <Pressable
          testID="tab-shared-with-me"
          accessibilityRole="tab"
          accessibilityState={{ selected: tab === 'shared' }}
          onPress={() => setTab('shared')}
          style={[styles.tab, tab === 'shared' && { borderBottomColor: theme.primary, borderBottomWidth: 2 }]}
        >
          <Text style={{ color: tab === 'shared' ? theme.text : theme.textMuted, fontWeight: '700' }}>
            Shared with me
          </Text>
        </Pressable>
      </View>

      {tab === 'mine' ? (
        <FlatList
          data={myBills}
          keyExtractor={(item) => item.id}
          renderItem={renderBill}
          style={styles.list}
          ListEmptyComponent={<Text style={{ color: theme.textMuted, padding: 16 }}>No bills yet.</Text>}
        />
      ) : (
        <Text style={{ color: theme.textMuted, padding: 16 }}>Nothing shared with you yet.</Text>
      )}

      <Text testID="scans-left-label" style={{ color: theme.textMuted, textAlign: 'center' }}>
        {scansLeft} scan{scansLeft === 1 ? '' : 's'} left this month
      </Text>

      <View style={styles.actions}>
        <PrimaryButton testID="scan-receipt-button" label="Scan receipt" onPress={startScanFlow} />
        <SecondaryButton testID="enter-manually-button" label="Enter manually" onPress={goManual} />
      </View>

      <ConsentSheet
        visible={consentVisible}
        onAllow={() => {
          recordAiConsent();
          setConsentVisible(false);
          router.push('/scan');
        }}
        onManual={() => {
          setConsentVisible(false);
          goManual();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 60, paddingHorizontal: 20 },
  header: { fontSize: 28, fontWeight: '800', marginBottom: 16 },
  tabs: { flexDirection: 'row', gap: 20, marginBottom: 8 },
  tab: { paddingVertical: 8 },
  list: { flex: 1 },
  billRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  billTitle: { fontSize: 16, fontWeight: '600' },
  actions: { gap: 12, marginVertical: 16 },
});

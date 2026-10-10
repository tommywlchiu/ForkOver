/**
 * Bill screen (SPEC.md sections 2.4, 4): the live bill. M3 only builds the
 * part in scope for this part of the milestone — the payer claiming items
 * for named people and seeing totals (src/lib/claims, src/lib/split).
 * Unclaimed/conflict sections, editing after sending, paid marks, and Venmo
 * buttons are payer controls for M5 and stay out of this screen for now.
 */
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Chip } from '../../../../components/Buttons';
import { NoConnectionBanner } from '../../../../components/NoConnectionBanner';
import { useThemeTokens } from '../../../../components/useThemeTokens';
import { formatMoney } from '../../../../lib/money/format';
import { claimStateMeta } from '../../../../lib/theme/tokens';
import { useBillStore } from '../../../../state/bill';
import { useConnectivityStore } from '../../../../state/connectivity';

export default function BillScreen() {
  const theme = useThemeTokens();
  const { id: billId } = useLocalSearchParams<{ id: string }>();

  const bill = useBillStore((s) => s.bills[billId]);
  const addPerson = useBillStore((s) => s.addPerson);
  const toggleMine = useBillStore((s) => s.toggleMine);
  const toggleShared = useBillStore((s) => s.toggleShared);
  const getSplit = useBillStore((s) => s.getSplit);
  const getResolvedItems = useBillStore((s) => s.getResolvedItems);
  const claimFor = useBillStore((s) => s.claimFor);
  const subscribeToBill = useBillStore((s) => s.subscribeToBill);
  const refetchBill = useBillStore((s) => s.refetchBill);
  const syncError = useBillStore((s) => s.syncErrors[billId]);
  const dismissSyncError = useBillStore((s) => s.dismissSyncError);
  const isConnected = useConnectivityStore((s) => s.isConnected);

  const [activePersonId, setActivePersonId] = useState<string | null>(null);
  const [addingPerson, setAddingPerson] = useState(false);
  const [newPersonName, setNewPersonName] = useState('');

  // SPEC 8.3: subscribe to realtime changes for this bill once it's mounted; resubscribing (a
  // fresh effect run) whenever the bill id itself changes.
  useEffect(() => {
    if (!billId) return undefined;
    const unsubscribe = subscribeToBill(billId);
    return unsubscribe;
  }, [billId, subscribeToBill]);

  // SPEC 8.3: "on reconnect, refetch the bill snapshot and resubscribe." The effect above already
  // resubscribes on remount; reconnecting doesn't remount this screen, so refetch explicitly here.
  const wasConnected = useRef(isConnected);
  useEffect(() => {
    if (isConnected && !wasConnected.current && billId) void refetchBill(billId);
    wasConnected.current = isConnected;
  }, [isConnected, billId, refetchBill]);

  const split = bill ? getSplit(bill.id) : null;
  const resolvedItems = bill ? getResolvedItems(bill.id) : [];
  const resolvedById = new Map(resolvedItems.map((r) => [r.itemId, r]));

  if (!bill) return <Redirect href="/" />;

  const controlsDisabled = !isConnected;

  const selectedPersonId = activePersonId ?? bill.payerId;
  const peopleById = new Map(bill.people.map((p) => [p.id, p.name]));

  const nameFor = (id: string) => (id === bill.payerId ? `${peopleById.get(id)} (you)` : (peopleById.get(id) ?? id));

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme.background }]} contentContainerStyle={styles.content}>
      <NoConnectionBanner />
      {syncError && (
        <Text
          testID="bill-sync-error"
          accessibilityLiveRegion="assertive"
          onPress={() => dismissSyncError(bill.id)}
          style={{ color: theme.danger, paddingVertical: 6 }}
        >
          {syncError}
        </Text>
      )}

      <Text style={[styles.title, { color: theme.text }]}>{bill.title}</Text>
      <Text style={{ color: theme.textMuted, marginBottom: 12 }}>Claiming as:</Text>

      <View style={styles.row}>
        {bill.people.map((person) => (
          <Chip
            key={person.id}
            testID={`person-row-${person.id}`}
            label={person.id === bill.payerId ? `${person.name} (you)` : person.name}
            selected={selectedPersonId === person.id}
            onPress={() => setActivePersonId(person.id)}
          />
        ))}
        <Chip
          testID="add-person-button"
          label="+ Add person"
          selected={addingPerson}
          disabled={controlsDisabled}
          onPress={() => setAddingPerson((v) => !v)}
        />
      </View>

      {addingPerson && (
        <View style={styles.row}>
          <TextInput
            testID="add-person-name-input"
            value={newPersonName}
            onChangeText={setNewPersonName}
            placeholder="Name"
            placeholderTextColor={theme.textMuted}
            accessibilityLabel="New person's name"
            editable={!controlsDisabled}
            style={[styles.nameInput, { color: theme.text, borderColor: theme.border }]}
          />
          <Text
            testID="confirm-add-person-button"
            accessibilityRole="button"
            accessibilityLabel="Add this person"
            accessibilityState={{ disabled: controlsDisabled }}
            onPress={() => {
              if (controlsDisabled) return;
              const trimmed = newPersonName.trim();
              if (trimmed) {
                const id = addPerson(bill.id, trimmed);
                setActivePersonId(id);
                setNewPersonName('');
                setAddingPerson(false);
              }
            }}
            style={{ color: controlsDisabled ? theme.textMuted : theme.primary, paddingHorizontal: 8 }}
          >
            Add
          </Text>
        </View>
      )}

      <Text style={[styles.sectionTitle, { color: theme.text }]}>Items</Text>
      {bill.items.map((item) => {
        const resolved = resolvedById.get(item.id);
        const state = resolved?.state ?? 'unclaimed';
        const meta = claimStateMeta[state];
        const holders = resolved && resolved.assignedTo.length > 0 ? resolved.assignedTo.map(nameFor).join(', ') : null;
        const mode = claimFor(bill.id, item.id, selectedPersonId);
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
            <Chip
              testID={`claim-item-${item.id}`}
              label="Mine"
              selected={mode === 'mine'}
              disabled={controlsDisabled}
              accessibilityLabel={`Claim ${item.name} as mine`}
              onPress={() => toggleMine(bill.id, item.id, selectedPersonId)}
            />
            <Chip
              testID={`share-item-${item.id}`}
              label="Share"
              selected={mode === 'shared'}
              disabled={controlsDisabled}
              accessibilityLabel={`Claim ${item.name} as shared`}
              onPress={() => toggleShared(bill.id, item.id, selectedPersonId)}
            />
          </View>
        );
      })}

      <Text style={[styles.sectionTitle, { color: theme.text }]}>Totals</Text>
      {split?.ok ? (
        bill.people.map((person) => {
          const share = split.shares.find((s) => s.personId === person.id);
          return (
            <View key={person.id} style={styles.totalRow}>
              <Text style={{ color: theme.text }}>{nameFor(person.id)}</Text>
              <Text testID={`person-total-${person.id}`} style={{ color: theme.text, fontWeight: '700' }}>
                {formatMoney(share?.totalCents ?? 0, bill.currency, 'en-US')}
              </Text>
            </View>
          );
        })
      ) : (
        <Text style={{ color: theme.danger }}>{split?.ok === false ? split.errors.map((e) => e.code).join(', ') : ''}</Text>
      )}
      {split?.ok && (
        <View style={[styles.totalRow, { marginTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.border, paddingTop: 8 }]}>
          <Text style={{ color: theme.text, fontWeight: '700' }}>Total</Text>
          <Text testID="grand-total" style={{ color: theme.text, fontWeight: '800' }}>
            {formatMoney(split.totals.grandTotalCents, bill.currency, 'en-US')}
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20, paddingTop: 60, paddingBottom: 60 },
  title: { fontSize: 24, fontWeight: '800', marginBottom: 4 },
  sectionTitle: { fontSize: 18, fontWeight: '700', marginTop: 20, marginBottom: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  nameInput: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 10 },
  itemInfo: { flex: 1 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
});

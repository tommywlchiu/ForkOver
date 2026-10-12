/**
 * Bill screen (SPEC.md sections 2.4, 4): the live bill. M3 only builds the
 * part in scope for this part of the milestone — the payer claiming items
 * for named people and seeing totals (src/lib/claims, src/lib/split).
 * Unclaimed/conflict sections, editing after sending, paid marks, and Venmo
 * buttons are payer controls for M5 and stay out of this screen for now.
 */
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Chip } from '../../../../components/Buttons';
import { ClaimableItemRow } from '../../../../components/ClaimableItemRow';
import { NoConnectionBanner } from '../../../../components/NoConnectionBanner';
import { SyncStatusBanner } from '../../../../components/SyncStatusBanner';
import { useThemeTokens } from '../../../../components/useThemeTokens';
import { personDisplayName } from '../../../../lib/claims/displayName';
import { formatMoney } from '../../../../lib/money/format';
import { useBillStore } from '../../../../state/bill';
import { useResolvedBill } from '../../../../state/useResolvedBill';

export default function BillScreen() {
  const theme = useThemeTokens();
  const { id: billId } = useLocalSearchParams<{ id: string }>();

  // `useResolvedBill` handles the local-id -> real-id rekey fallback, offline gating, and the
  // realtime subscribe/reconnect-refetch lifecycle uniformly across every bill screen (code
  // review on PR #31).
  const { bill, controlsDisabled, syncError, dismissSyncError, notSynced, retrySync } = useResolvedBill(billId);
  const addPerson = useBillStore((s) => s.addPerson);
  const toggleMine = useBillStore((s) => s.toggleMine);
  const toggleShared = useBillStore((s) => s.toggleShared);
  const getSplit = useBillStore((s) => s.getSplit);
  const getResolvedItems = useBillStore((s) => s.getResolvedItems);
  const claimFor = useBillStore((s) => s.claimFor);

  const [activePersonId, setActivePersonId] = useState<string | null>(null);
  const [addingPerson, setAddingPerson] = useState(false);
  const [newPersonName, setNewPersonName] = useState('');

  const split = bill ? getSplit(bill.id) : null;
  const resolvedItems = bill ? getResolvedItems(bill.id) : [];
  const resolvedById = new Map(resolvedItems.map((r) => [r.itemId, r]));

  if (!bill) return <Redirect href="/" />;

  const selectedPersonId = activePersonId ?? bill.payerId;
  const peopleById = new Map(bill.people.map((p) => [p.id, p.name]));

  // The viewer here is always the payer (this screen is payer-only, SPEC 2.4) - not necessarily
  // `selectedPersonId`, which is just whichever person the payer is currently claiming on behalf
  // of (FR-32).
  const nameFor = (id: string) =>
    personDisplayName({ name: peopleById.get(id) ?? id, personId: id, payerId: bill.payerId, viewerPersonId: bill.payerId });

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme.background }]} contentContainerStyle={styles.content}>
      <NoConnectionBanner />
      <SyncStatusBanner notSynced={notSynced} retrySync={retrySync} syncError={syncError} dismissSyncError={dismissSyncError} />

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
        const holdersLabel = resolved && resolved.assignedTo.length > 0 ? resolved.assignedTo.map(nameFor).join(', ') : null;
        const mode = claimFor(bill.id, item.id, selectedPersonId);

        return (
          <ClaimableItemRow
            key={item.id}
            item={item}
            currency={bill.currency}
            state={state}
            holdersLabel={holdersLabel}
            mode={mode}
            disabled={controlsDisabled}
            onToggleMine={() => toggleMine(bill.id, item.id, selectedPersonId)}
            onToggleShared={() => toggleShared(bill.id, item.id, selectedPersonId)}
          />
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
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
});

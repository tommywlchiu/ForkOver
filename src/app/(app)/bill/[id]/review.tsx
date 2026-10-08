/**
 * Review (SPEC.md sections 2.2 step 4, 7.5). Items stream in as the stand-in
 * reader replays them (src/state/bill.ts `startScan`); editable, deletable,
 * addable, with quantity-line Merge, discount/tax/fees, tip, the
 * green-check/mismatch banners, and the unreadable-tip warning. Also serves
 * manual entry, which starts with an empty item list and no printed figures.
 */
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Chip, PrimaryButton } from '../../../../components/Buttons';
import { useThemeTokens } from '../../../../components/useThemeTokens';
import { formatMoney } from '../../../../lib/money/format';
import { parseMoneyInput } from '../../../../lib/money/parseMoneyInput';
import { reconcile } from '../../../../lib/receipt/reconcile';
import type { Fee, Tip } from '../../../../lib/split/split';
import { useBillStore } from '../../../../state/bill';

const TIP_CHIP_BPS: Record<'18' | '20' | '22', number> = { '18': 1800, '20': 2000, '22': 2200 };

export default function Review() {
  const theme = useThemeTokens();
  const { id: billId } = useLocalSearchParams<{ id: string }>();

  const bill = useBillStore((s) => s.bills[billId]);
  const updateItem = useBillStore((s) => s.updateItem);
  const removeItem = useBillStore((s) => s.removeItem);
  const mergeItems = useBillStore((s) => s.mergeItems);
  const addItem = useBillStore((s) => s.addItem);
  const setDiscount = useBillStore((s) => s.setDiscount);
  const setTax = useBillStore((s) => s.setTax);
  const addFee = useBillStore((s) => s.addFee);
  const updateFee = useBillStore((s) => s.updateFee);
  const removeFee = useBillStore((s) => s.removeFee);
  const setTip = useBillStore((s) => s.setTip);
  const confirmReview = useBillStore((s) => s.confirmReview);
  const getSplit = useBillStore((s) => s.getSplit);

  const [newItemName, setNewItemName] = useState('');
  const [newItemPrice, setNewItemPrice] = useState('');
  const [tipBase, setTipBase] = useState<'preTax' | 'postTax'>('preTax');
  const [showCustomTip, setShowCustomTip] = useState(false);
  const [customTipMode, setCustomTipMode] = useState<'percent' | 'amount'>('percent');
  const [customTipText, setCustomTipText] = useState('');

  const split = bill ? getSplit(bill.id) : null;

  const groupedByName = useMemo(() => {
    if (!bill) return new Map<string, string[]>();
    const groups = new Map<string, string[]>();
    for (const item of bill.items) {
      groups.set(item.name, [...(groups.get(item.name) ?? []), item.id]);
    }
    return groups;
  }, [bill]);

  if (!bill) return <Redirect href="/" />;

  const currency = bill.currency;
  const recon =
    split?.ok
      ? reconcile({
          itemsCents: split.totals.subtotalCents,
          discountCents: split.totals.discountCents,
          taxCents: split.totals.taxCents,
          feesCents: split.totals.feesCents,
          tipCents: split.totals.tipCents,
          printedSubtotalCents: bill.printedSubtotalCents,
          printedTotalCents: bill.printedTotalCents,
        })
      : null;

  const applyTip = (tip: Tip) => setTip(bill.id, tip, null);

  const onSelectPercentChip = (key: '18' | '20' | '22') => applyTip({ kind: 'percent', bps: TIP_CHIP_BPS[key], base: tipBase });

  const onToggleBase = (base: 'preTax' | 'postTax') => {
    setTipBase(base);
    if (bill.tip.kind === 'percent') applyTip({ kind: 'percent', bps: bill.tip.bps, base });
  };

  const applyCustomTip = () => {
    if (customTipMode === 'amount') {
      const cents = parseMoneyInput(customTipText, currency);
      if (cents !== null) applyTip({ kind: 'amount', cents });
    } else {
      const percent = Number(customTipText);
      if (Number.isFinite(percent) && percent >= 0) applyTip({ kind: 'percent', bps: Math.round(percent * 100), base: tipBase });
    }
  };

  const selectedTipChip: '18' | '20' | '22' | null =
    bill.tip.kind === 'percent'
      ? ((Object.entries(TIP_CHIP_BPS).find(([, bps]) => bps === (bill.tip as Extract<Tip, { kind: 'percent' }>).bps)?.[0] as
          | '18'
          | '20'
          | '22'
          | undefined) ?? null)
      : null;

  const tipLabel: Record<NonNullable<typeof bill.tipSource>, string> = {
    printed: 'Printed tip',
    handwritten: 'Handwritten tip',
    autoGratuity: 'Automatic gratuity',
    mixed: 'Tip',
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme.background }]} contentContainerStyle={styles.content}>
      <Text style={[styles.title, { color: theme.text }]}>{bill.merchantName ?? 'Review the bill'}</Text>

      {bill.scanState === 'streaming' && (
        <View testID="scan-streaming-indicator" style={styles.row}>
          <ActivityIndicator color={theme.primary} />
          <Text style={{ color: theme.textMuted }}>Reading receipt…</Text>
        </View>
      )}
      {bill.scanState === 'error' && (
        <Text testID="scan-error-banner" style={{ color: theme.danger }}>
          Couldn&apos;t read that receipt ({bill.scanError}). Enter items manually below.
        </Text>
      )}

      {bill.items.map((item) => {
        return (
          <View key={item.id} style={[styles.itemRow, { borderColor: theme.border }]}>
            <TextInput
              testID={`item-name-${item.id}`}
              value={item.name}
              onChangeText={(text) => updateItem(bill.id, item.id, { name: text })}
              accessibilityLabel={`Item name: ${item.name}`}
              style={[styles.itemNameInput, { color: theme.text }]}
            />
            <TextInput
              key={`price-${item.priceCents}`}
              testID={`item-price-${item.id}`}
              defaultValue={(item.priceCents / 100).toFixed(2)}
              onEndEditing={(e) => {
                const cents = parseMoneyInput(e.nativeEvent.text, currency);
                if (cents !== null) updateItem(bill.id, item.id, { priceCents: cents });
              }}
              keyboardType="decimal-pad"
              accessibilityLabel={`Item price: ${formatMoney(item.priceCents, currency, 'en-US')}`}
              style={[styles.itemPriceInput, { color: theme.text }]}
            />
            <Text
              testID={`delete-item-${item.id}`}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${item.name}`}
              onPress={() => removeItem(bill.id, item.id)}
              style={{ color: theme.danger, paddingHorizontal: 8 }}
            >
              ✕
            </Text>
          </View>
        );
      })}
      {[...groupedByName.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([name, ids]) => (
          <Text
            key={name}
            testID={`merge-items-${name}`}
            accessibilityRole="button"
            accessibilityLabel={`Merge ${name} back into one line`}
            onPress={() => mergeItems(bill.id, ids)}
            style={{ color: theme.primary, marginBottom: 8 }}
          >
            Merge {name} ({ids.length})
          </Text>
        ))}

      <View style={styles.row}>
        <TextInput
          testID="add-item-name-input"
          value={newItemName}
          onChangeText={setNewItemName}
          placeholder="Item name"
          placeholderTextColor={theme.textMuted}
          style={[styles.itemNameInput, { color: theme.text, borderColor: theme.border, borderWidth: 1 }]}
        />
        <TextInput
          testID="add-item-price-input"
          value={newItemPrice}
          onChangeText={setNewItemPrice}
          placeholder="0.00"
          placeholderTextColor={theme.textMuted}
          keyboardType="decimal-pad"
          style={[styles.itemPriceInput, { color: theme.text, borderColor: theme.border, borderWidth: 1 }]}
        />
        <Text
          testID="add-item-button"
          accessibilityRole="button"
          accessibilityLabel="Add item"
          onPress={() => {
            const cents = parseMoneyInput(newItemPrice, currency);
            if (newItemName.trim() && cents !== null) {
              addItem(bill.id, { name: newItemName.trim(), priceCents: cents });
              setNewItemName('');
              setNewItemPrice('');
            }
          }}
          style={{ color: theme.primary, paddingHorizontal: 8 }}
        >
          Add
        </Text>
      </View>

      {recon && bill.printedSubtotalCents !== null && (
        <Text
          testID={recon.subtotal.status === 'match' ? 'subtotal-match-banner' : 'subtotal-mismatch-banner'}
          style={{ color: recon.subtotal.status === 'match' ? theme.success : theme.danger }}
        >
          {recon.subtotal.status === 'match'
            ? `✓ Items match the receipt (${formatMoney(bill.printedSubtotalCents, currency, 'en-US')})`
            : `Items add up to ${formatMoney(recon.subtotal.computedCents, currency, 'en-US')}, receipt says ${formatMoney(bill.printedSubtotalCents, currency, 'en-US')}`}
        </Text>
      )}
      {recon && bill.printedTotalCents !== null && (
        <Text
          testID={recon.total.status === 'match' ? 'total-match-banner' : 'total-mismatch-banner'}
          style={{ color: recon.total.status === 'match' ? theme.success : theme.danger }}
        >
          {recon.total.status === 'match'
            ? `✓ Total matches the receipt (${formatMoney(bill.printedTotalCents, currency, 'en-US')})`
            : `Total comes to ${formatMoney(recon.total.computedCents, currency, 'en-US')}, receipt says ${formatMoney(bill.printedTotalCents, currency, 'en-US')}`}
        </Text>
      )}
      {recon?.unreadableTip && (
        <Text testID="unreadable-tip-warning" style={{ color: theme.onWarningSurface, backgroundColor: theme.warningSurface, padding: 8, borderRadius: 8 }}>
          Looks like there&apos;s a tip we couldn&apos;t read.
        </Text>
      )}
      {bill.warnings.map((warning, index) => (
        <Text key={index} testID={`receipt-warning-${index}`} style={{ color: theme.onWarningSurface }}>
          {warning}
        </Text>
      ))}

      <Text style={[styles.sectionTitle, { color: theme.text }]}>Discount &amp; tax</Text>
      <View style={styles.row}>
        <Text style={{ color: theme.textMuted, width: 80 }}>Discount</Text>
        <TextInput
          key={`discount-${bill.discountCents}`}
          testID="discount-input"
          defaultValue={(bill.discountCents / 100).toFixed(2)}
          onEndEditing={(e) => {
            const cents = parseMoneyInput(e.nativeEvent.text, currency);
            if (cents !== null) setDiscount(bill.id, cents);
          }}
          keyboardType="decimal-pad"
          accessibilityLabel="Discount amount"
          style={[styles.itemPriceInput, { color: theme.text, borderColor: theme.border, borderWidth: 1 }]}
        />
      </View>
      <View style={styles.row}>
        <Text style={{ color: theme.textMuted, width: 80 }}>Tax</Text>
        <TextInput
          key={`tax-${bill.taxCents}`}
          testID="tax-input"
          defaultValue={(bill.taxCents / 100).toFixed(2)}
          onEndEditing={(e) => {
            const cents = parseMoneyInput(e.nativeEvent.text, currency);
            if (cents !== null) setTax(bill.id, cents);
          }}
          keyboardType="decimal-pad"
          accessibilityLabel="Tax amount"
          style={[styles.itemPriceInput, { color: theme.text, borderColor: theme.border, borderWidth: 1 }]}
        />
      </View>

      <Text style={[styles.sectionTitle, { color: theme.text }]}>Fees</Text>
      {bill.fees.map((fee: Fee) => (
        <View key={fee.id} style={styles.row}>
          <TextInput
            testID={`fee-label-${fee.id}`}
            value={fee.label}
            onChangeText={(text) => updateFee(bill.id, fee.id, { label: text })}
            accessibilityLabel={`Fee label: ${fee.label}`}
            style={[styles.itemNameInput, { color: theme.text }]}
          />
          <TextInput
            key={`fee-amount-${fee.cents}`}
            testID={`fee-amount-${fee.id}`}
            defaultValue={(fee.cents / 100).toFixed(2)}
            onEndEditing={(e) => {
              const cents = parseMoneyInput(e.nativeEvent.text, currency);
              if (cents !== null) updateFee(bill.id, fee.id, { cents });
            }}
            keyboardType="decimal-pad"
            accessibilityLabel={`Fee amount: ${formatMoney(fee.cents, currency, 'en-US')}`}
            style={[styles.itemPriceInput, { color: theme.text, borderColor: theme.border, borderWidth: 1 }]}
          />
          <Chip
            testID={`fee-split-toggle-${fee.id}`}
            label={fee.split === 'proportional' ? 'Proportional' : 'Even'}
            selected={fee.split === 'equal'}
            onPress={() => updateFee(bill.id, fee.id, { split: fee.split === 'proportional' ? 'equal' : 'proportional' })}
          />
          <Text
            testID={`remove-fee-${fee.id}`}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${fee.label}`}
            onPress={() => removeFee(bill.id, fee.id)}
            style={{ color: theme.danger, paddingHorizontal: 8 }}
          >
            ✕
          </Text>
        </View>
      ))}
      <Text
        testID="add-fee-button"
        accessibilityRole="button"
        accessibilityLabel="Add a fee"
        onPress={() => addFee(bill.id, { label: 'Fee', cents: 0, split: 'proportional' })}
        style={{ color: theme.primary }}
      >
        + Add fee
      </Text>

      <Text style={[styles.sectionTitle, { color: theme.text }]}>Tip</Text>
      {bill.tipSource !== null ? (
        <Text style={{ color: theme.text }}>
          {tipLabel[bill.tipSource]}: {formatMoney(bill.tip.kind === 'amount' ? bill.tip.cents : 0, currency, 'en-US')}
        </Text>
      ) : (
        <>
          <Text style={{ color: theme.textMuted }}>
            {bill.tip.kind === 'amount' && bill.tip.cents === 0 ? 'No tip' : `Tip: ${formatMoney(split?.ok ? split.totals.tipCents : 0, currency, 'en-US')}`}
          </Text>
          <View style={styles.row}>
            {(['18', '20', '22'] as const).map((key) => (
              <Chip
                key={key}
                testID={`tip-chip-${key}`}
                label={`${key}%`}
                selected={selectedTipChip === key}
                onPress={() => onSelectPercentChip(key)}
              />
            ))}
            <Chip
              testID="tip-chip-custom"
              label="Custom"
              selected={showCustomTip}
              onPress={() => setShowCustomTip((v) => !v)}
            />
          </View>
          <View style={styles.row}>
            <Chip testID="tip-base-pretax" label="Pre-tax" selected={tipBase === 'preTax'} onPress={() => onToggleBase('preTax')} />
            <Chip testID="tip-base-posttax" label="Post-tax" selected={tipBase === 'postTax'} onPress={() => onToggleBase('postTax')} />
          </View>
          {showCustomTip && (
            <View style={styles.row}>
              <Chip testID="tip-custom-mode-percent" label="%" selected={customTipMode === 'percent'} onPress={() => setCustomTipMode('percent')} />
              <Chip testID="tip-custom-mode-amount" label="$" selected={customTipMode === 'amount'} onPress={() => setCustomTipMode('amount')} />
              <TextInput
                testID="tip-custom-input"
                value={customTipText}
                onChangeText={setCustomTipText}
                keyboardType="decimal-pad"
                placeholder={customTipMode === 'percent' ? '15' : '0.00'}
                placeholderTextColor={theme.textMuted}
                style={[styles.itemPriceInput, { color: theme.text, borderColor: theme.border, borderWidth: 1 }]}
              />
              <Text
                testID="tip-custom-apply-button"
                accessibilityRole="button"
                accessibilityLabel="Apply custom tip"
                onPress={applyCustomTip}
                style={{ color: theme.primary, paddingHorizontal: 8 }}
              >
                Apply
              </Text>
            </View>
          )}
        </>
      )}

      <PrimaryButton
        testID="looks-right-button"
        label="Looks right"
        onPress={() => {
          confirmReview(bill.id);
          router.replace({ pathname: '/bill/[id]/share', params: { id: bill.id } });
        }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20, paddingTop: 60, paddingBottom: 60, gap: 6 },
  title: { fontSize: 24, fontWeight: '800', marginBottom: 8 },
  sectionTitle: { fontSize: 18, fontWeight: '700', marginTop: 16, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  itemRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 6 },
  itemNameInput: { flex: 1, fontSize: 16 },
  itemPriceInput: { width: 90, fontSize: 16, textAlign: 'right', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
});

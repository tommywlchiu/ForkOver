/**
 * One item row with its claim-state label, holders, and (unless `readOnly`) the "Mine"/"Share"
 * chips - shared by the payer's own bill screen (`src/app/(app)/bill/[id]/index.tsx`) and the
 * public claim link (`src/app/b/[token].tsx`), SPEC.md sections 2.3 and 2.4. These two screens'
 * item rows were copy-pasted instead of shared when the claim link was built, and had already
 * drifted cosmetically (code review) - this is the one place either screen's row rendering lives
 * now, the same reasoning `useResolvedBill`/`SyncStatusBanner` were extracted for.
 */
import { StyleSheet, Text, View } from 'react-native';
import { Chip } from './Buttons';
import { useThemeTokens } from './useThemeTokens';
import { formatMoney } from '../lib/money/format';
import { claimStateMeta } from '../lib/theme/tokens';
import type { ClaimMode, ItemClaimState } from '../lib/claims/resolve';

export function ClaimableItemRow({
  item,
  currency,
  state,
  holdersLabel,
  mode,
  disabled,
  readOnly,
  onToggleMine,
  onToggleShared,
}: {
  item: { id: string; name: string; priceCents: number };
  currency: string;
  state: ItemClaimState;
  /** Already-formatted "who has this" text (e.g. "Alex (you), Bailey"), or `null` if unclaimed. */
  holdersLabel: string | null;
  /** This row's claim state for whoever "self" is on the calling screen; `'none'` if unclaimed by them. */
  mode: ClaimMode | 'none';
  disabled: boolean;
  /** Closed bills (FR-25) and anything else that's summary-only: hides the claim chips. */
  readOnly?: boolean;
  onToggleMine: () => void;
  onToggleShared: () => void;
}) {
  const theme = useThemeTokens();
  const meta = claimStateMeta[state];
  const priceLabel = formatMoney(item.priceCents, currency, 'en-US');

  return (
    <View
      style={[styles.itemRow, { borderColor: theme.border }]}
      accessibilityLabel={`${item.name}, ${priceLabel}, ${holdersLabel ? `claimed by ${holdersLabel}` : 'unclaimed'}`}
    >
      <View style={styles.itemInfo}>
        <Text style={{ color: theme.text, fontWeight: '600' }}>{item.name}</Text>
        <Text style={{ color: theme.textMuted }}>{priceLabel}</Text>
        <Text style={{ color: theme.textMuted, fontSize: 13 }}>
          {meta.label}
          {holdersLabel ? `: ${holdersLabel}` : ''}
        </Text>
      </View>
      {!readOnly && (
        <>
          <Chip
            testID={`claim-item-${item.id}`}
            label="Mine"
            selected={mode === 'mine'}
            disabled={disabled}
            accessibilityLabel={`Claim ${item.name} as mine`}
            onPress={onToggleMine}
          />
          <Chip
            testID={`share-item-${item.id}`}
            label="Share"
            selected={mode === 'shared'}
            disabled={disabled}
            accessibilityLabel={`Claim ${item.name} as shared`}
            onPress={onToggleShared}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 10 },
  itemInfo: { flex: 1 },
});

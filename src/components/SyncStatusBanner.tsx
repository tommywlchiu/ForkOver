/**
 * The "not synced yet" (persistent, with retry) and "sync error" (one-off, dismissible) rows
 * every bill screen shows (SPEC.md section 8.3, M4). Takes `useResolvedBill`'s own fields as
 * props rather than calling the hook itself, so a screen that already calls `useResolvedBill` for
 * `controlsDisabled` etc. doesn't pay for computing it twice.
 *
 * Code review on PR #31 (second round): this JSX block was pasted verbatim into three screens
 * after the data-layer fix centralized into `useResolvedBill` - the same failure mode one layer
 * down. Mirrors `NoConnectionBanner`'s own pattern (a small, self-contained, drop-in component)
 * so omitting it from a fourth bill screen is a structural impossibility, not a discipline
 * problem.
 */
import { StyleSheet, Text, View } from 'react-native';
import { useThemeTokens } from './useThemeTokens';

export function SyncStatusBanner({
  notSynced,
  retrySync,
  syncError,
  dismissSyncError,
}: {
  notSynced: boolean;
  retrySync: () => void;
  syncError: string | undefined;
  dismissSyncError: () => void;
}) {
  const theme = useThemeTokens();

  if (!notSynced && !syncError) return null;

  return (
    <>
      {notSynced && (
        <View style={styles.row}>
          <Text testID="bill-not-synced" style={{ color: theme.danger, flex: 1 }}>
            This bill hasn&apos;t saved yet.
          </Text>
          <Text testID="retry-sync-button" accessibilityRole="button" accessibilityLabel="Retry saving this bill" onPress={retrySync} style={{ color: theme.primary }}>
            Retry
          </Text>
        </View>
      )}
      {syncError && (
        <Text testID="bill-sync-error" accessibilityLiveRegion="assertive" onPress={dismissSyncError} style={[styles.syncError, { color: theme.danger }]}>
          {syncError}
        </Text>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  syncError: { paddingVertical: 6 },
});

/**
 * "No connection" banner shown when the device detects connectivity loss (SPEC.md section 8.3, M4 NFR-8).
 *
 * Displays at the top of screens to inform the user that changes may not sync until connectivity is restored.
 * Uses danger theme colors to signal an error state.
 */
import { StyleSheet, Text, View } from 'react-native';
import { useThemeTokens } from './useThemeTokens';
import { useConnectivityStore } from '../state/connectivity';

export function NoConnectionBanner() {
  const isConnected = useConnectivityStore((state) => state.isConnected);
  const theme = useThemeTokens();

  if (isConnected) {
    return null;
  }

  return (
    <View
      style={[styles.banner, { backgroundColor: theme.danger }]}
      testID="no-connection-banner"
      accessibilityLiveRegion="assertive"
    >
      <Text
        style={[styles.bannerText, { color: theme.onDanger }]}
        accessibilityLabel="No connection"
      >
        No connection
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerText: {
    fontSize: 14,
    fontWeight: '600',
  },
});

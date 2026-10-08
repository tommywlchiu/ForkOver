/**
 * Scan (SPEC.md sections 2.2, 4): camera plus photo-library option. The
 * shutter press starts the latency clock (8.8, `scan_shutter`); the actual
 * item stream is rendered on Review, which subscribes to the same bill.
 */
import * as ImagePicker from 'expo-image-picker';
import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { PrimaryButton, SecondaryButton } from '../../components/Buttons';
import { useThemeTokens } from '../../components/useThemeTokens';
import type { ImageCapture } from '../../data/receiptReader';
import { useBillStore } from '../../state/bill';
import { useSessionStore } from '../../state/session';

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

async function pickFromCamera(): Promise<ImagePicker.ImagePickerAsset | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) return null;
  const result = await ImagePicker.launchCameraAsync({ quality: 0.85 });
  return result.canceled ? null : result.assets[0];
}

async function pickFromLibrary(): Promise<ImagePicker.ImagePickerAsset | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return null;
  const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.85 });
  return result.canceled ? null : result.assets[0];
}

export default function Scan() {
  const theme = useThemeTokens();
  const aiConsentAt = useSessionStore((s) => s.aiConsentAt);
  const userId = useSessionStore((s) => s.userId)!;
  const username = useSessionStore((s) => s.username)!;
  const createDraftBill = useBillStore((s) => s.createDraftBill);
  const startScan = useBillStore((s) => s.startScan);
  const [busy, setBusy] = useState(false);

  if (aiConsentAt === null) return <Redirect href="/" />;

  const beginScan = (asset: ImagePicker.ImagePickerAsset) => {
    const payer = { id: userId, name: capitalize(username) };
    const billId = createDraftBill(payer);
    const image: ImageCapture = { uri: asset.uri, bytes: new Uint8Array(), mediaType: 'image/jpeg' };
    // Fire and forget: Review (mounted next) renders the stream as it arrives.
    void startScan(billId, image);
    router.replace({ pathname: '/bill/[id]/review', params: { id: billId } });
  };

  const onShutterPress = async () => {
    setBusy(true);
    try {
      let asset = await pickFromCamera();
      // The web build has no native camera capture; fall back to the file picker.
      if (!asset && Platform.OS === 'web') asset = await pickFromLibrary();
      if (asset) beginScan(asset);
    } finally {
      setBusy(false);
    }
  };

  const onLibraryPress = async () => {
    setBusy(true);
    try {
      const asset = await pickFromLibrary();
      if (asset) beginScan(asset);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <Text style={[styles.title, { color: theme.text }]}>Point at the receipt</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        Get the whole receipt in frame, then tap the shutter.
      </Text>

      <View style={styles.spacer} />

      {busy ? (
        <ActivityIndicator size="large" color={theme.primary} testID="scan-busy-indicator" />
      ) : (
        <PrimaryButton testID="shutter-button" label="Take photo" onPress={onShutterPress} accessibilityHint="Opens the camera" />
      )}
      <SecondaryButton
        testID="pick-photo-button"
        label="Choose from library"
        onPress={onLibraryPress}
        disabled={busy}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: 'flex-end', gap: 12, paddingBottom: 60 },
  title: { fontSize: 24, fontWeight: '800' },
  hint: { fontSize: 15 },
  spacer: { flex: 1 },
});

/**
 * Registers this device's Expo push token so the (later) `notify` function (SPEC.md 8.7) has
 * somewhere to send to. SPEC 8.1: `push_tokens` (user_id, token (unique), platform, updated_at).
 *
 * Follows Expo's current guidance for SDK 57
 * (https://docs.expo.dev/push-notifications/push-notifications-setup/): request permission (if
 * not already granted), read the Expo push token, and upsert it via the signed-in Supabase
 * client. Never throws - permission denial, a simulator/emulator with no push capability, and a
 * missing EAS `projectId` (this app has none configured yet; see AGENTS.md/the PR for the
 * follow-up) are all expected, recoverable states, not bugs, so every failure is caught and
 * logged instead of surfacing to the caller.
 *
 * Native-only: Expo's push service only issues tokens for iOS/Android apps built with EAS, so this
 * is a no-op on web (`Platform.OS === 'web'`) and skipped on simulators/emulators (`Device.isDevice`
 * is false), matching `push_tokens.platform`'s `('ios' | 'android')` check constraint.
 */
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { supabase } from './supabaseClient';

export async function registerForPushNotifications(userId: string): Promise<void> {
  if (Platform.OS === 'web' || !Device.isDevice) return;

  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') return;

    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) {
      console.warn('[pushTokens] no EAS projectId configured; skipping push registration');
      return;
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    const platform = Platform.OS === 'ios' ? 'ios' : 'android';

    const { error } = await supabase
      .from('push_tokens')
      .upsert(
        { user_id: userId, token, platform, updated_at: new Date().toISOString() },
        { onConflict: 'token' },
      );
    if (error) console.warn('[pushTokens] failed to upsert push token', error.message);
  } catch (e) {
    console.warn('[pushTokens] registration failed', e);
  }
}

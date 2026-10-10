/**
 * Registers this device's Expo push token so the (later) `notify` function (SPEC.md 8.7) has
 * somewhere to send to. SPEC 8.1: `push_tokens` (user_id, token (unique), platform, updated_at).
 *
 * Follows Expo's current guidance for SDK 57
 * (https://docs.expo.dev/push-notifications/push-notifications-setup/): request permission (if
 * not already granted), read the Expo push token, and register it via the `register_push_token`
 * RPC (`supabase/migrations/20261010000000_create_push_tokens.sql`). That RPC, not a plain
 * client-side upsert, because `token` is globally unique (SPEC 8.1) and a shared or resold device
 * can carry a token that already belongs to a *different* user under self-row-only RLS; the RPC
 * reassigns it atomically instead of raising (or, with a plain upsert, failing silently).
 *
 * Returns whether registration succeeded, so the caller can decide whether to retry. Never
 * throws - permission denial, a simulator/emulator with no push capability, and a missing EAS
 * `projectId` (this app has none configured yet; see AGENTS.md/the PR for the follow-up) are all
 * expected, recoverable states, not bugs, so every failure is caught and logged instead of
 * surfacing to the caller.
 *
 * Native-only: Expo's push service only issues tokens for iOS/Android apps built with EAS, so this
 * is a no-op on web, any other RN platform, and simulators/emulators (`expo-device`'s
 * `Device.isDevice`), matching `push_tokens.platform`'s `('ios' | 'android')` check constraint.
 */
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { supabase } from './supabaseClient';

export async function registerForPushNotifications(userId: string): Promise<boolean> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
  if (!Device.isDevice) return false;
  const platform = Platform.OS;

  try {
    if (platform === 'android') {
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
    if (finalStatus !== 'granted') return false;

    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) {
      console.warn('[pushTokens] no EAS projectId configured; skipping push registration');
      return false;
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });

    const { error } = await supabase.rpc('register_push_token', {
      p_user_id: userId,
      p_token: token,
      p_platform: platform,
    });
    if (error) {
      console.warn('[pushTokens] failed to register push token', error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[pushTokens] registration failed', e);
    return false;
  }
}

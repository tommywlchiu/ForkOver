/**
 * The one Supabase client for native (iOS/Android/macOS/tvOS); `supabaseClient.web.ts` is the web
 * build's version, which Metro picks automatically via the `.web.ts` platform extension (SPEC.md
 * section 8). Session persistence here uses `expo-sqlite`'s `localStorage` polyfill, not
 * `@react-native-async-storage/async-storage`: it's Expo's own current guidance
 * (https://docs.expo.dev/guides/using-supabase/) for Expo SDK 57. `detectSessionInUrl` stays
 * false because native has no URL to read a session from; the OAuth deep-link flow in
 * `src/state/session.ts` reads the redirect URL itself.
 */
import 'expo-sqlite/localStorage/install';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY must be set.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: localStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

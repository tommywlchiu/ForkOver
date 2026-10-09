/**
 * The one Supabase client for the app (SPEC.md section 8). Session persistence uses
 * `expo-sqlite`'s `localStorage` polyfill, not `@react-native-async-storage/async-storage`:
 * it's Expo's own current guidance (https://docs.expo.dev/guides/using-supabase/) for Expo SDK
 * 57, works on iOS/Android/macOS/tvOS, and is a no-op pass-through to the browser's real
 * `localStorage` on web. `detectSessionInUrl` stays false because native has no URL to read a
 * session from; the OAuth deep-link flow in `src/state/session.ts` reads the redirect URL itself.
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
    storage: typeof localStorage === 'undefined' ? undefined : localStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

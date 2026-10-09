/**
 * Web variant of the Supabase client (SPEC.md section 8). Metro picks this file automatically for
 * web builds (the `.web.ts` platform extension). The browser already has a real `localStorage`,
 * so this skips `expo-sqlite`'s SQLite-backed polyfill entirely: that polyfill's web build needs
 * extra Metro wasm/worker and cross-origin-isolation header setup (expo-sqlite's web support is
 * still alpha - https://docs.expo.dev/versions/v57.0.0/sdk/sqlite/), none of which web needs here
 * since it isn't just a pass-through, it's unused weight. `src/data/supabaseClient.ts` is the
 * native (iOS/Android) version.
 */
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY must be set.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // `localStorage` doesn't exist during Expo Router's static-rendering SSR pass (Node, no DOM).
    storage: typeof localStorage === 'undefined' ? undefined : localStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

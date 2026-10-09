/**
 * Real Supabase Auth session (SPEC.md section 11, M3 part 1; SPEC 8.1/8.2). Google only for now:
 * Apple sign-in is deferred to M6, when the $99/yr Apple Developer account is needed regardless
 * for store submission (Sign in with Apple requires one to configure).
 *
 * `signIn()` opens the provider's consent page in a browser and awaits the `forkover://` redirect
 * (SPEC.md section 11; Supabase's native deep-link pattern:
 * https://supabase.com/docs/guides/auth/native-mobile-deep-linking). Once `setSession` succeeds,
 * `onAuthStateChange` below (subscribed once, at module scope, so it also fires on a cold start
 * when a persisted session is restored) fetches the user's `profiles` row and populates the rest
 * of this store. Screens should still await `signIn()` to know when the flow finished or failed.
 */
import { create } from 'zustand';
import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri } from 'expo-auth-session';
import * as QueryParams from 'expo-auth-session/build/QueryParams';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../data/supabaseClient';

// Required once for the web platform; a no-op on native (per Supabase's deep-linking guide).
WebBrowser.maybeCompleteAuthSession();

export type AuthProvider = 'google';

export type SetUsernameResult = { ok: true } | { ok: false; reason: 'taken' | 'unknown' };

type ProfileRow = {
  username: string | null;
  display_name: string | null;
  venmo_username: string | null;
  ai_consent_at: string | null;
};

export type SessionState = {
  isSignedIn: boolean;
  userId: string | null;
  displayName: string | null;
  username: string | null;
  venmoUsername: string | null;
  /** Set once the payer allows the AI consent sheet (SPEC 2.2, 9); mirrors `profiles.ai_consent_at`. */
  aiConsentAt: number | null;
  /** Scans used in the current calendar month, for the free-tier counter (SPEC 13 default 5). */
  scansUsedThisMonth: number;

  signIn: (provider: AuthProvider) => Promise<void>;
  setUsername: (username: string, venmoUsername?: string) => Promise<SetUsernameResult>;
  recordAiConsent: () => Promise<void>;
  recordScanUsed: () => void;
  signOut: () => Promise<void>;
};

const SIGNED_OUT_FIELDS = {
  isSignedIn: false,
  userId: null,
  displayName: null,
  username: null,
  venmoUsername: null,
  aiConsentAt: null,
  scansUsedThisMonth: 0,
} as const;

async function fetchProfile(userId: string): Promise<ProfileRow | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('username, display_name, venmo_username, ai_consent_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    console.warn('[session] failed to load profile', error.message);
    return null;
  }
  return data;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  ...SIGNED_OUT_FIELDS,

  signIn: async (provider) => {
    const redirectTo = makeRedirectUri();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (error) throw error;
    if (!data?.url) throw new Error('Sign-in did not return a URL.');

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (result.type !== 'success') {
      throw new Error(result.type === 'cancel' ? 'Sign-in was canceled.' : 'Sign-in failed.');
    }

    const { params, errorCode } = QueryParams.getQueryParams(result.url);
    if (errorCode) throw new Error(errorCode);
    const { access_token, refresh_token } = params;
    if (!access_token || !refresh_token) throw new Error('Sign-in did not return a session.');

    const { error: sessionError } = await supabase.auth.setSession({ access_token, refresh_token });
    if (sessionError) throw sessionError;
    // `onAuthStateChange` (below) populates the rest of the store once the session lands.
  },

  setUsername: async (username, venmoUsername) => {
    const userId = get().userId;
    if (!userId) return { ok: false, reason: 'unknown' };
    const normalizedVenmo = venmoUsername?.trim() ? venmoUsername.trim() : null;
    const { error } = await supabase
      .from('profiles')
      .update({ username, venmo_username: normalizedVenmo })
      .eq('id', userId);
    if (error) {
      // Postgres unique_violation.
      if (error.code === '23505') return { ok: false, reason: 'taken' };
      console.warn('[session] setUsername failed', error.message);
      return { ok: false, reason: 'unknown' };
    }
    set({ username, venmoUsername: normalizedVenmo });
    return { ok: true };
  },

  recordAiConsent: async () => {
    const userId = get().userId;
    if (!userId) return;
    const now = new Date();
    // Optimistic (SPEC 8.3): the caller navigates straight to Scan, which gates on
    // `aiConsentAt` synchronously, so this must land before the network round-trip finishes.
    set({ aiConsentAt: now.getTime() });
    const { error } = await supabase
      .from('profiles')
      .update({ ai_consent_at: now.toISOString() })
      .eq('id', userId);
    if (error) {
      console.warn('[session] recordAiConsent failed', error.message);
      set({ aiConsentAt: null });
    }
  },

  recordScanUsed: () => set((state) => ({ scansUsedThisMonth: state.scansUsedThisMonth + 1 })),

  signOut: async () => {
    await supabase.auth.signOut();
    set({ ...SIGNED_OUT_FIELDS });
  },
}));

function applySession(session: Session | null) {
  if (!session?.user) {
    useSessionStore.setState({ ...SIGNED_OUT_FIELDS });
    return;
  }
  const { user } = session;
  const metadataName =
    (user.user_metadata?.full_name as string | undefined) ?? (user.user_metadata?.name as string | undefined) ?? null;
  useSessionStore.setState({
    isSignedIn: true,
    userId: user.id,
    displayName: metadataName,
  });
  fetchProfile(user.id).then((profile) => {
    if (!profile || useSessionStore.getState().userId !== user.id) return;
    useSessionStore.setState({
      username: profile.username,
      displayName: profile.display_name ?? metadataName,
      venmoUsername: profile.venmo_username,
      aiConsentAt: profile.ai_consent_at ? new Date(profile.ai_consent_at).getTime() : null,
    });
  });
}

supabase.auth.getSession().then(({ data }) => applySession(data.session));
supabase.auth.onAuthStateChange((_event, session) => applySession(session));

export const FREE_SCANS_PER_MONTH = 3;

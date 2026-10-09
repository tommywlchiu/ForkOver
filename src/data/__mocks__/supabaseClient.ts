/**
 * Manual jest mock for `../data/supabaseClient` (auto-used by `jest.mock('../data/supabaseClient')`,
 * no factory needed). Fakes just enough of Supabase Auth and postgrest-js to drive `signIn` and
 * `setUsername`/`recordAiConsent` through the real screens in integration tests, without a
 * network call or `expo-sqlite`'s native module. `setSession`'s `access_token` doubles as the
 * fake user id (see the matching `expo-web-browser` mock in each integration test).
 */
type AuthChangeEvent = 'SIGNED_IN' | 'SIGNED_OUT';

type Profile = {
  username: string | null;
  display_name: string | null;
  venmo_username: string | null;
  ai_consent_at: string | null;
};

type FakeSession = {
  access_token: string;
  refresh_token: string;
  user: { id: string; user_metadata: { full_name: string } };
};

let currentSession: FakeSession | null = null;
let userCounter = 0;
const profiles = new Map<string, Profile>();
const listeners = new Set<(event: AuthChangeEvent, session: FakeSession | null) => void>();

function notify(event: AuthChangeEvent, session: FakeSession | null) {
  listeners.forEach((cb) => cb(event, session));
}

/** Test-only helper: clears every fake user/profile and the active session between tests. */
export function __resetFakeSupabase() {
  currentSession = null;
  userCounter = 0;
  profiles.clear();
}

export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: currentSession }, error: null }),
    onAuthStateChange: (cb: (event: AuthChangeEvent, session: FakeSession | null) => void) => {
      listeners.add(cb);
      return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
    },
    signInWithOAuth: async () => ({ data: { url: 'https://mock-oauth.example/authorize' }, error: null }),
    // Each call is a fresh sign-in (not a restored session), so it gets a brand new user/profile,
    // same as a real new Google account would on first launch.
    setSession: async ({ access_token }: { access_token: string; refresh_token: string }) => {
      const userId = `mock-user-${++userCounter}`;
      profiles.set(userId, { username: null, display_name: null, venmo_username: null, ai_consent_at: null });
      currentSession = { access_token, refresh_token: `mock-refresh-${userId}`, user: { id: userId, user_metadata: { full_name: 'Google User' } } };
      notify('SIGNED_IN', currentSession);
      return { data: { session: currentSession }, error: null };
    },
    signOut: async () => {
      currentSession = null;
      notify('SIGNED_OUT', null);
      return { error: null };
    },
  },
  from: (table: string) => {
    if (table !== 'profiles') throw new Error(`supabaseClient mock: unhandled table "${table}"`);
    return {
      select: () => ({
        eq: (_column: string, id: string) => ({
          maybeSingle: async () => ({ data: profiles.get(id) ?? null, error: null }),
        }),
      }),
      update: (patch: Partial<Profile>) => ({
        eq: async (_column: string, id: string) => {
          const existing = profiles.get(id);
          if (!existing) return { error: { code: 'PGRST116', message: 'row not found' } };
          if (patch.username) {
            const taken = Array.from(profiles.entries()).some(
              ([otherId, profile]) => otherId !== id && profile.username === patch.username,
            );
            if (taken) {
              return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
            }
          }
          profiles.set(id, { ...existing, ...patch });
          return { error: null };
        },
      }),
    };
  },
};

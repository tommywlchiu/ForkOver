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
let forcedRpcError: { message: string } | null = null;
const profiles = new Map<string, Profile>();
const listeners = new Set<(event: AuthChangeEvent, session: FakeSession | null) => void>();

function notify(event: AuthChangeEvent, session: FakeSession | null) {
  listeners.forEach((cb) => cb(event, session));
}

/** Test-only helper: clears every fake user/profile and the active session between tests. */
export function __resetFakeSupabase() {
  currentSession = null;
  userCounter = 0;
  forcedRpcError = null;
  profiles.clear();
}

/** Test-only helper: seeds a profile row directly, for RPCs that search across users. */
export function __seedProfile(id: string, profile: Partial<Profile>) {
  profiles.set(id, {
    username: null,
    display_name: null,
    venmo_username: null,
    ai_consent_at: null,
    ...profile,
  });
}

/** Test-only helper: makes the next `rpc` call resolve with an error, to exercise error states. */
export function __forceNextRpcError(message = 'mock rpc failure') {
  forcedRpcError = { message };
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
  // Mirrors `search_usernames` (SPEC 8.2): requires a session, >= 2 chars, matches by prefix,
  // at most 10 rows, ordered by username.
  rpc: async (fn: string, args: Record<string, unknown>) => {
    if (fn !== 'search_usernames') throw new Error(`supabaseClient mock: unhandled rpc "${fn}"`);
    if (forcedRpcError) {
      const error = forcedRpcError;
      forcedRpcError = null;
      return { data: null, error };
    }
    if (!currentSession) {
      return { data: null, error: { message: 'search_usernames requires a session (signed in or anonymous)' } };
    }
    const prefix = String(args.p_prefix ?? '').trim().toLowerCase();
    if (prefix.length < 2) return { data: [], error: null };
    const rows = Array.from(profiles.entries())
      .filter(([, profile]) => !!profile.username && profile.username.toLowerCase().startsWith(prefix))
      .sort((a, b) => a[1].username!.localeCompare(b[1].username!))
      .slice(0, 10)
      .map(([id, profile]) => ({ id, username: profile.username, display_name: profile.display_name }));
    return { data: rows, error: null };
  },
};

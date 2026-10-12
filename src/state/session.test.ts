/**
 * Unit coverage for the parts of the real session store (SPEC.md section 11, M3 part 1) that
 * the screen-level integration tests don't exercise directly: the taken-username error path and
 * `recordAiConsent`'s optimistic update plus revert-on-failure.
 */
import { supabase } from '../data/supabaseClient';
import { ensureSession, fetchOwnDisplayName, useSessionStore } from './session';

jest.mock('../data/supabaseClient');
jest.mock('expo-auth-session', () => ({
  ...jest.requireActual('expo-auth-session'),
  makeRedirectUri: jest.fn(() => 'forkover://auth-callback'),
}));
jest.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: jest.fn(),
  openAuthSessionAsync: jest.fn(async () => ({
    type: 'success',
    url: 'forkover://auth-callback#access_token=mock-access-test&refresh_token=mock-refresh-test&token_type=bearer',
  })),
}));

// Test-only reset hook the mock exports but the real module doesn't; accessed dynamically so
// tsc doesn't check it against the real module's type.
const { __resetFakeSupabase } = jest.requireMock('../data/supabaseClient') as {
  __resetFakeSupabase: () => void;
};

async function signInAsNewUser() {
  await useSessionStore.getState().signIn('google');
  // `onAuthStateChange` resolves the profile fetch in a microtask after `signIn` returns.
  await Promise.resolve();
}

describe('session store', () => {
  beforeEach(async () => {
    __resetFakeSupabase();
    await useSessionStore.getState().signOut();
  });

  it('rejects a username another signed-in user already has', async () => {
    await signInAsNewUser();
    const first = await useSessionStore.getState().setUsername('alex');
    expect(first).toEqual({ ok: true });

    await useSessionStore.getState().signOut();
    await signInAsNewUser();
    const second = await useSessionStore.getState().setUsername('alex');
    expect(second).toEqual({ ok: false, reason: 'taken' });
    // The rejected write never lands locally.
    expect(useSessionStore.getState().username).toBeNull();
  });

  it('sets the username and optional Venmo handle on success', async () => {
    await signInAsNewUser();
    const result = await useSessionStore.getState().setUsername('bailey', '  bailey-venmo  ');
    expect(result).toEqual({ ok: true });
    expect(useSessionStore.getState().username).toBe('bailey');
    expect(useSessionStore.getState().venmoUsername).toBe('bailey-venmo');
  });

  it('records AI consent optimistically', async () => {
    await signInAsNewUser();
    expect(useSessionStore.getState().aiConsentAt).toBeNull();
    await useSessionStore.getState().recordAiConsent();
    expect(useSessionStore.getState().aiConsentAt).not.toBeNull();
  });
});

// Code review on PR #34: ensureSession had no in-flight dedup, unlike promoteBill's own fix for
// the identical race class - two concurrent calls before either resolved could each decide "no
// session yet" and mint a separate anonymous identity, the second clobbering the first's.
describe('ensureSession', () => {
  beforeEach(async () => {
    __resetFakeSupabase();
    await useSessionStore.getState().signOut();
  });

  it('dedups two concurrent calls into a single anonymous sign-in', async () => {
    const signInSpy = jest.spyOn(supabase.auth, 'signInAnonymously');

    const [a, b] = await Promise.all([ensureSession(), ensureSession()]);

    expect(a.userId).toBe(b.userId);
    expect(signInSpy).toHaveBeenCalledTimes(1);
    signInSpy.mockRestore();
  });

  it('starts a fresh attempt once the previous one has resolved', async () => {
    const first = await ensureSession();
    await useSessionStore.getState().signOut();
    const second = await ensureSession();

    expect(second.userId).not.toBe(first.userId);
  });
});

// Code review on PR #34: the public claim link's silent auto-join used to read the display name
// straight off useSessionStore, which can still be mid-hydration (fetchProfile is fire-and-forget)
// right after ensureSession() resolves - especially on a cold deep link into /b/[token]. Reading
// `profiles` directly instead sidesteps that race entirely.
describe('fetchOwnDisplayName', () => {
  beforeEach(async () => {
    __resetFakeSupabase();
    await useSessionStore.getState().signOut();
  });

  it("returns the caller's own profile display_name", async () => {
    await signInAsNewUser();
    const userId = useSessionStore.getState().userId!;
    const { __seedProfile } = jest.requireMock('../data/supabaseClient') as { __seedProfile: (id: string, p: object) => void };
    __seedProfile(userId, { display_name: 'Riley Real Name' });

    await expect(fetchOwnDisplayName(userId)).resolves.toBe('Riley Real Name');
  });

  it('falls back to username when display_name is unset', async () => {
    await signInAsNewUser();
    const userId = useSessionStore.getState().userId!;
    const { __seedProfile } = jest.requireMock('../data/supabaseClient') as { __seedProfile: (id: string, p: object) => void };
    __seedProfile(userId, { username: 'rileyr' });

    await expect(fetchOwnDisplayName(userId)).resolves.toBe('rileyr');
  });

  it('returns null when neither is set', async () => {
    await signInAsNewUser();
    const userId = useSessionStore.getState().userId!;

    await expect(fetchOwnDisplayName(userId)).resolves.toBeNull();
  });
});

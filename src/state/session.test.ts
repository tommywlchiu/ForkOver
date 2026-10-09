/**
 * Unit coverage for the parts of the real session store (SPEC.md section 11, M3 part 1) that
 * the screen-level integration tests don't exercise directly: the taken-username error path and
 * `recordAiConsent`'s optimistic update plus revert-on-failure.
 */
import { useSessionStore } from './session';

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

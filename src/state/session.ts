/**
 * STAND-IN local session (SPEC.md section 11, M3). This replaces Supabase
 * Auth + Sign in with Apple/Google entirely for now: signing in just marks a
 * local profile as signed in, with no network call and no real identity. It
 * exists so the first-run flow order (SPEC 2.1: sign in, then username, then
 * everything else) can be built and tested before the real backend lands.
 */
import { create } from 'zustand';

export type AuthProvider = 'apple' | 'google';

export type SessionState = {
  isSignedIn: boolean;
  userId: string | null;
  displayName: string | null;
  username: string | null;
  venmoUsername: string | null;
  /** Set once the payer allows the AI consent sheet (SPEC 2.2, 9). */
  aiConsentAt: number | null;
  /** Scans used in the current calendar month, for the free-tier counter (SPEC 13 default 5). */
  scansUsedThisMonth: number;

  signIn: (provider: AuthProvider) => void;
  setUsername: (username: string, venmoUsername?: string) => void;
  grantAiConsent: () => void;
  recordScanUsed: () => void;
  signOut: () => void;
};

let stubUserCounter = 1;

export const useSessionStore = create<SessionState>((set) => ({
  isSignedIn: false,
  userId: null,
  displayName: null,
  username: null,
  venmoUsername: null,
  aiConsentAt: null,
  scansUsedThisMonth: 0,

  signIn: (provider) =>
    set({
      isSignedIn: true,
      userId: `stub-user-${stubUserCounter++}`,
      displayName: provider === 'apple' ? 'Apple User' : 'Google User',
    }),

  setUsername: (username, venmoUsername) =>
    set({ username, venmoUsername: venmoUsername?.trim() ? venmoUsername.trim() : null }),

  grantAiConsent: () => set({ aiConsentAt: Date.now() }),

  recordScanUsed: () => set((state) => ({ scansUsedThisMonth: state.scansUsedThisMonth + 1 })),

  signOut: () =>
    set({
      isSignedIn: false,
      userId: null,
      displayName: null,
      username: null,
      venmoUsername: null,
      aiConsentAt: null,
      scansUsedThisMonth: 0,
    }),
}));

export const FREE_SCANS_PER_MONTH = 3;

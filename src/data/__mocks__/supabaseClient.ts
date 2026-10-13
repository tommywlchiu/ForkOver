/**
 * Manual jest mock for `../data/supabaseClient` (auto-used by `jest.mock('../data/supabaseClient')`,
 * no factory needed). Fakes just enough of Supabase Auth and postgrest-js to drive `signIn` and
 * `setUsername`/`recordAiConsent` through the real screens in integration tests, without a
 * network call or `expo-sqlite`'s native module. `setSession`'s `access_token` doubles as the
 * fake user id (see the matching `expo-web-browser` mock in each integration test).
 *
 * `profiles` is its own small, hand-written table (unchanged from M3). The M4 bill tables
 * (`bills`, `bill_people`, `bill_items`, `bill_fees`, `claims`) and the `create_manual_bill` RPC
 * (`src/data/supabaseBillStore.ts`) are backed by a generic in-memory table + query-builder below
 * instead: real RLS is only ever proven against the live local Postgres (`supabase/tests/*.sql`,
 * run with `npx supabase test db --local`), so this doesn't re-check policy, only the happy path
 * `supabaseBillStore.ts`'s own methods take - exactly as much backend as the integration tests
 * (which drive the real screens, including manual entry's `create_manual_bill` call) need to
 * reach their assertions without a live Supabase project. No realtime fan-out either: every
 * integration test acts through a single client, and optimistic local writes already cover that.
 */
// Imported from `billTables.ts` (not `supabaseBillStore.ts` directly, and not redeclared here) so
// the mock's table list and `subscribeToBillChanges`'s realtime table list can't drift apart the
// way they already have once (code review on PR #31): `assignments`/`payments` aren't read or
// written by `supabaseBillStore.ts` yet, but accepting them here is harmless and future-proof.
// `billTables.ts` is a separate, dependency-free module specifically so this import doesn't go
// through `supabaseBillStore.ts` -> `./supabaseClient`, which Jest resolves back to this very
// mock file and silently left `ALL_BILL_TABLES` `undefined` here (a real circular-import bug this
// review also caught).
import { ALL_BILL_TABLES } from '../billTables';

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
  user: { id: string; user_metadata: { full_name: string }; is_anonymous?: boolean };
};

let currentSession: FakeSession | null = null;
let userCounter = 0;
let forcedRpcError: { message: string } | null = null;
const profiles = new Map<string, Profile>();
const listeners = new Set<(event: AuthChangeEvent, session: FakeSession | null) => void>();

// --- M4 bill tables: a tiny in-memory Postgres stand-in, see the module doc above -------------

type Row = Record<string, unknown>;
const BILL_TABLES = ALL_BILL_TABLES;
type BillTable = (typeof BILL_TABLES)[number];
const billTables: Record<BillTable, Map<string, Row>> = {
  bills: new Map(),
  bill_people: new Map(),
  bill_items: new Map(),
  bill_fees: new Map(),
  claims: new Map(),
  assignments: new Map(),
  payments: new Map(),
};

/** Mirrors `is_bill_member` (SPEC 8.2) for the one select this mock gates - see the `bills`
 *  branch in `FakeQuery.run()`'s `select` case. */
function isBillMember(billId: string, userId: string | undefined): boolean {
  if (!userId) return false;
  const bill = billTables.bills.get(billId);
  if (bill?.payer_user_id === userId) return true;
  return [...billTables.bill_people.values()].some((row) => row.bill_id === billId && row.user_id === userId);
}

/** `claims` has no single-column id (its primary key is (item_id, person_id)); everything else does. */
function keyFor(table: BillTable, row: Row): string {
  if (table === 'claims') return `${row.item_id}:${row.person_id}`;
  return row.id as string;
}

/** A minimal, chainable, awaitable stand-in for a postgrest-js query. */
class FakeQuery implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private filters: ((row: Row) => boolean)[] = [];
  private wantsSingle = false;
  private wantsMaybeSingle = false;

  constructor(
    private table: BillTable,
    private op: 'select' | 'insert' | 'update' | 'delete' | 'upsert',
    private payload?: Row | Row[],
  ) {}

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  in(column: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  select(_columns?: string): this {
    return this;
  }
  single(): this {
    this.wantsSingle = true;
    return this;
  }
  maybeSingle(): this {
    this.wantsMaybeSingle = true;
    return this;
  }

  private run(): { data: unknown; error: { message: string } | null } {
    const rows = billTables[this.table];
    const matches = () => [...rows.values()].filter((row) => this.filters.every((f) => f(row)));

    if (this.op === 'select') {
      let found = matches();
      // The one bit of real RLS this generic, policy-blind stand-in simulates (see the module
      // doc): `bills_select_members` (SPEC 8.2 "Membership") - without it, the public claim
      // route's "is this caller already a member?" probe (`fetchBillByShareTokenIfMember`) would
      // find a bill by its `share_token` for literally anyone, including a guest who hasn't
      // joined yet, and the route would never reach `join_bill` at all.
      if (this.table === 'bills') {
        found = found.filter((row) => isBillMember(row.id as string, currentSession?.user.id));
      }
      if (this.wantsSingle || this.wantsMaybeSingle) {
        if (found.length === 0) {
          return this.wantsSingle ? { data: null, error: { message: 'no rows found' } } : { data: null, error: null };
        }
        return { data: found[0], error: null };
      }
      return { data: found, error: null };
    }
    if (this.op === 'insert') {
      const items = Array.isArray(this.payload) ? this.payload : this.payload ? [this.payload] : [];
      const inserted = items.map((item) => {
        const row: Row = { id: crypto.randomUUID(), ...item };
        rows.set(keyFor(this.table, row), row);
        return row;
      });
      return { data: this.wantsSingle ? inserted[0] : inserted, error: null };
    }
    if (this.op === 'update') {
      const found = matches();
      found.forEach((row) => Object.assign(row, this.payload));
      return { data: found, error: null };
    }
    if (this.op === 'delete') {
      const found = matches();
      found.forEach((row) => rows.delete(keyFor(this.table, row)));
      return { data: found, error: null };
    }
    // upsert
    const upserted = (Array.isArray(this.payload) ? this.payload : this.payload ? [this.payload] : []).map((item) => {
      const row: Row = { ...item };
      const key = keyFor(this.table, row);
      const merged = { ...(rows.get(key) ?? {}), ...row };
      rows.set(key, merged);
      return merged;
    });
    return { data: upserted, error: null };
  }

  then<TResult1 = { data: unknown; error: { message: string } | null }, TResult2 = never>(
    onFulfilled?: ((value: { data: unknown; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onFulfilled, onRejected);
  }
}

/** Test-only helper: clears every in-memory bill row between tests. */
export function __resetFakeBillTables() {
  for (const table of BILL_TABLES) billTables[table].clear();
}

function notify(event: AuthChangeEvent, session: FakeSession | null) {
  listeners.forEach((cb) => cb(event, session));
}

/** Test-only helper: clears every fake user/profile and the active session between tests. */
export function __resetFakeSupabase() {
  currentSession = null;
  userCounter = 0;
  forcedRpcError = null;
  profiles.clear();
  __resetFakeBillTables();
}

function isBillTable(table: string): table is BillTable {
  return (BILL_TABLES as readonly string[]).includes(table);
}

/** A no-op realtime channel: every integration test drives one client, so there is no second
 *  client's write to fan in - optimistic local writes already cover what a screen renders. */
function fakeChannel() {
  const channel = {
    on: () => channel,
    subscribe: () => channel,
  };
  return channel;
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
    // A guest opening a `b/[token]` link with no session at all (session.ts's `ensureSession`,
    // SPEC 3 "anonymous sessions for guests"). Same shape as `setSession` above: a fresh fake
    // user/profile per call, `is_anonymous: true` so callers can tell a guest from a real sign-in.
    signInAnonymously: async () => {
      const userId = `mock-anon-user-${++userCounter}`;
      profiles.set(userId, { username: null, display_name: null, venmo_username: null, ai_consent_at: null });
      currentSession = {
        access_token: userId,
        refresh_token: `mock-refresh-${userId}`,
        user: { id: userId, user_metadata: { full_name: 'Guest' }, is_anonymous: true },
      };
      notify('SIGNED_IN', currentSession);
      return { data: { session: currentSession, user: currentSession.user }, error: null };
    },
  },
  from: (table: string) => {
    if (isBillTable(table)) {
      return {
        select: (columns?: string) => new FakeQuery(table, 'select').select(columns),
        insert: (payload: Row | Row[]) => new FakeQuery(table, 'insert', payload),
        update: (payload: Row) => new FakeQuery(table, 'update', payload),
        delete: () => new FakeQuery(table, 'delete'),
        upsert: (payload: Row | Row[]) => new FakeQuery(table, 'upsert', payload),
      };
    }
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
  // Dispatches by function name. `create_manual_bill`
  // (supabase/migrations/20261010100000_create_manual_bill.sql): mints a draft bill for the
  // signed-in caller and, same as `handle_new_bill`'s trigger, gives them their own `bill_people`
  // payer row immediately. `search_usernames` (SPEC 8.2) mirrors the real RPC: requires a
  // session, >= 2 chars, matches by prefix, at most 10 rows, ordered by username.
  rpc: async (fn: string, args: Record<string, unknown> = {}) => {
    if (forcedRpcError) {
      const error = forcedRpcError;
      forcedRpcError = null;
      return { data: null, error };
    }

    if (fn === 'create_manual_bill') {
      if (!currentSession) return { data: null, error: { message: 'create_manual_bill requires a signed-in session' } };
      const bill: Row = {
        id: crypto.randomUUID(),
        payer_user_id: currentSession.user.id,
        status: 'draft',
        title: null,
        merchant_name: null,
        currency: 'USD',
        discount_cents: 0,
        tax_cents: 0,
        tip: null,
        sent_at: null,
        created_at: new Date().toISOString(),
        share_token: `mock-share-token-${crypto.randomUUID()}`,
      };
      billTables.bills.set(bill.id as string, bill);
      const payerPerson: Row = {
        id: crypto.randomUUID(),
        bill_id: bill.id,
        user_id: currentSession.user.id,
        display_name: currentSession.user.user_metadata.full_name,
        kind: 'payer',
      };
      billTables.bill_people.set(payerPerson.id as string, payerPerson);
      return { data: bill, error: null };
    }

    if (fn === 'join_bill') {
      // `code` mirrors the real `join_bill`'s distinct SQLSTATE per case (supabase/migrations/
      // 20261012000000_join_bill_error_codes.sql) - `joinBillByToken` classifies by this, not by
      // the message text, so the mock has to carry it too for that path to be exercised at all
      // under jest (real RLS/errcodes only ever run against local Postgres otherwise).
      if (!currentSession) return { data: null, error: { message: 'join_bill requires a session (signed in or anonymous)', code: 'FO001' } };
      const shareToken = String(args.p_share_token ?? '');
      const name = String(args.p_display_name ?? '').trim();
      const bill = [...billTables.bills.values()].find((row) => row.share_token === shareToken);
      if (!bill) return { data: null, error: { message: 'no bill found for that share link', code: 'FO002' } };
      if (bill.status === 'closed') return { data: null, error: { message: 'this bill is closed', code: 'FO003' } };
      if (name.length < 1 || name.length > 30) {
        return { data: null, error: { message: 'display_name must be 1 to 30 characters', code: 'FO004' } };
      }
      const existing = [...billTables.bill_people.values()].find(
        (row) => row.bill_id === bill.id && row.user_id === currentSession!.user.id,
      );
      if (existing) return { data: existing, error: null };
      const person: Row = {
        id: crypto.randomUUID(),
        bill_id: bill.id,
        user_id: currentSession.user.id,
        display_name: name,
        kind: currentSession.user.is_anonymous ? 'guest' : 'member',
      };
      billTables.bill_people.set(person.id as string, person);
      return { data: person, error: null };
    }

    if (fn === 'get_bill_payer_venmo') {
      const billId = args.p_bill_id as string;
      // Mirrors the real RPC's `is_bill_member` gate (supabase/migrations/20261011010000_
      // bill_payer_venmo.sql) - without this, a regression dropping that check server-side would
      // only ever be caught by the separate pgTAP suite, not `npm test` (the `bills` select
      // branch above was deliberately built to simulate this exact membership boundary already).
      if (!isBillMember(billId, currentSession?.user.id)) return { data: null, error: null };
      const bill = billTables.bills.get(billId);
      if (!bill) return { data: null, error: null };
      const payer = profiles.get(bill.payer_user_id as string);
      return { data: payer?.venmo_username ?? null, error: null };
    }

    // `invite_bill_member` (supabase/migrations/20261011010000_invite_bill_member.sql): mirrors
    // the real RPC's happy path (payer-only, rejects a closed bill, idempotent on a repeat
    // invite, flags `already_member`) for the integration tests that drive the share screen's
    // "send in app" flow. Same check order as the real function, and returns an array of one row
    // (a `returns table` RPC), not a bare object, to match it.
    if (fn === 'invite_bill_member') {
      if (!currentSession) return { data: null, error: { message: 'invite_bill_member requires a session' } };
      const billId = args.p_bill_id as string;
      const userId = args.p_user_id as string;
      const bill = billTables.bills.get(billId);
      if (!bill) return { data: null, error: { message: `no bill found for id ${billId}` } };
      if (bill.payer_user_id !== currentSession.user.id) {
        return { data: null, error: { message: "invite_bill_member: only the bill's payer may invite a member" } };
      }
      if (bill.status === 'closed') {
        return { data: null, error: { message: `invite_bill_member: bill ${billId} is closed` } };
      }
      if (userId === currentSession.user.id) {
        return { data: null, error: { message: 'invite_bill_member: the payer cannot invite themselves' } };
      }
      const profile = profiles.get(userId);
      if (!profile) return { data: null, error: { message: `invite_bill_member: no profile found for user ${userId}` } };
      const existing = [...billTables.bill_people.values()].find((row) => row.bill_id === billId && row.user_id === userId);
      if (existing) return { data: [{ ...existing, already_member: true }], error: null };
      const person: Row = {
        id: crypto.randomUUID(),
        bill_id: billId,
        user_id: userId,
        display_name: profile.display_name ?? profile.username ?? 'Invited member',
        kind: 'member',
      };
      billTables.bill_people.set(person.id as string, person);
      return { data: [{ ...person, already_member: false }], error: null };
    }

    if (fn === 'search_usernames') {
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
    }

    throw new Error(`supabaseClient mock: unhandled rpc "${fn}"`);
  },
  channel: (_name: string) => fakeChannel(),
  removeChannel: async () => undefined,
};

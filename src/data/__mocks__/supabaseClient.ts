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

// --- M4 bill tables: a tiny in-memory Postgres stand-in, see the module doc above -------------

type Row = Record<string, unknown>;
const BILL_TABLES = ['bills', 'bill_people', 'bill_items', 'bill_fees', 'claims'] as const;
type BillTable = (typeof BILL_TABLES)[number];
const billTables: Record<BillTable, Map<string, Row>> = {
  bills: new Map(),
  bill_people: new Map(),
  bill_items: new Map(),
  bill_fees: new Map(),
  claims: new Map(),
};

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
      const found = matches();
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
    const row: Row = { ...(this.payload as Row) };
    const key = keyFor(this.table, row);
    rows.set(key, { ...(rows.get(key) ?? {}), ...row });
    return { data: [rows.get(key)], error: null };
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
  },
  from: (table: string) => {
    if (isBillTable(table)) {
      return {
        select: (columns?: string) => new FakeQuery(table, 'select').select(columns),
        insert: (payload: Row | Row[]) => new FakeQuery(table, 'insert', payload),
        update: (payload: Row) => new FakeQuery(table, 'update', payload),
        delete: () => new FakeQuery(table, 'delete'),
        upsert: (payload: Row) => new FakeQuery(table, 'upsert', payload),
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

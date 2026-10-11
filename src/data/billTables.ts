/**
 * Every table SPEC.md section 8.3 names for a bill's realtime subscription (SPEC 8.1). A separate,
 * dependency-free module (not declared inside `supabaseBillStore.ts`) so both that module and the
 * mock Supabase client (`src/data/__mocks__/supabaseClient.ts`) can import the same list without
 * either importing the other - the mock importing `supabaseBillStore.ts` directly creates a
 * circular require through `./supabaseClient` (which Jest resolves back to the mock itself),
 * which silently left the mock's table list `undefined` (code review on PR #31).
 */
export const ALL_BILL_TABLES = ['bills', 'bill_people', 'bill_items', 'bill_fees', 'claims', 'assignments', 'payments'] as const;

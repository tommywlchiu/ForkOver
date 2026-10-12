/**
 * Share screen's "Send in app" flow, driven through the real screens (SPEC.md 8.2, M4
 * in-app-sending task): searching by username and selecting a result calls `invite_bill_member`
 * and shows a confirmation. The mock Supabase client's realtime channel never fires in tests (see
 * its own module doc) - full realtime pickup is confirmed separately against a real local
 * Supabase stack - so this only exercises the RPC call and the resulting server-side row, not the
 * screen re-rendering the people list from a realtime event.
 */
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { supabase } from '../data/supabaseClient';
import { useBillStore } from '../state/bill';
import { useSessionStore } from '../state/session';

jest.mock('../data/supabaseClient');
const { __resetFakeSupabase, __seedProfile } = jest.requireMock('../data/supabaseClient') as {
  __resetFakeSupabase: () => void;
  __seedProfile: (id: string, profile: { username?: string | null; display_name?: string | null }) => void;
};
jest.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: jest.fn(),
  openAuthSessionAsync: jest.fn(async () => ({
    type: 'success',
    url: 'forkover://auth-callback#access_token=mock-access-test-user&refresh_token=mock-refresh-test-user&token_type=bearer',
  })),
}));

async function press(testID: string) {
  await fireEvent.press(await screen.findByTestId(testID));
}

async function typeInto(testID: string, text: string) {
  await fireEvent.changeText(await screen.findByTestId(testID), text);
}

async function signIn() {
  await press('sign-in-google-button');
  await typeInto('username-input', 'alex');
  await press('username-continue-button');
}

function onlyBill() {
  const bills = Object.values(useBillStore.getState().bills);
  if (bills.length !== 1) throw new Error(`expected exactly one bill, found ${bills.length}`);
  return bills[0];
}

describe('send in app', () => {
  beforeEach(async () => {
    useBillStore.setState({ bills: {} });
    await useSessionStore.getState().signOut();
    __resetFakeSupabase();
  });

  it('invites a searched user, who becomes a real member on the bill', async () => {
    __seedProfile('friend-1', { username: 'baileyb', display_name: 'Bailey' });

    renderRouter('./src/app', { initialUrl: '/' });
    await signIn();
    await press('enter-manually-button');
    await press('looks-right-button');

    await typeInto('username-search-input', 'bai');
    await press('username-search-result-friend-1');

    await waitFor(() => expect(screen.getByTestId('invite-confirmation')).toBeTruthy());
    expect(screen.getByText('Invited @baileyb')).toBeTruthy();

    // The screen itself doesn't add Bailey to its own people list - that happens through the
    // realtime subscription (confirmed separately against a real local Supabase stack; the mock
    // channel here never fires - see this file's own module doc). What the RPC call did do is
    // create the real row server-side, which is what the realtime refetch would read.
    const bill = onlyBill();
    const { data: peopleRows } = await supabase.from('bill_people').select('display_name,kind,user_id').eq('bill_id', bill.id);
    expect(peopleRows).toEqual(
      expect.arrayContaining([expect.objectContaining({ display_name: 'Bailey', kind: 'member', user_id: 'friend-1' })]),
    );

    // Selecting a result counts as sending the bill, the same as copying or sharing the link.
    expect(bill.sentAt).not.toBeNull();
    // Full sign-in-to-screen flow, same as the other integration tests that drive it (e.g.
    // paymentFlow.test.tsx) - past the 5000ms default so CI contention doesn't flake it.
  }, 15000);

  it('shows an error and does not add a member when the invite is rejected', async () => {
    __seedProfile('friend-2', { username: 'casey', display_name: 'Casey' });

    renderRouter('./src/app', { initialUrl: '/' });
    await signIn();
    await press('enter-manually-button');
    await press('looks-right-button');

    const billId = onlyBill().id;
    // Close the bill's *server-side* row directly so the RPC's own closed-bill rejection fires
    // (SPEC 8.5), without driving a second screen flow (payer controls, assignment/paid marks)
    // just to get there - the invite RPC reads `bills.status` itself, not local zustand state.
    await supabase.from('bills').update({ status: 'closed' }).eq('id', billId);

    await typeInto('username-search-input', 'cas');
    await press('username-search-result-friend-2');

    await waitFor(() => expect(screen.getByTestId('invite-error')).toBeTruthy());
    expect(onlyBill().people.some((p) => p.name === 'Casey')).toBe(false);
  }, 15000);
});

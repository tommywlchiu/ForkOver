/**
 * Drives the public bill link (SPEC.md sections 2.3, 4 `b/[token]`) end to end: a guest opens the
 * link cold (no session at all), types a name, claims an item, and sees their own total - the
 * other half of "shared bills" from the payer-facing realtime store (already covered by
 * supabaseBillStore.test.ts and paymentFlow.test.tsx).
 *
 * The payer side (creating and opening a bill) is driven directly through the store, not the
 * scan/review UI - that flow is already covered elsewhere; this test is about the link.
 */
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { useBillStore } from '../state/bill';
import { supabase } from '../data/supabaseClient';

jest.mock('../data/supabaseClient');
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

/** Creates and opens a one-item bill as a signed-in payer, returning its share token and item id. */
async function createOpenBillWithOneItem(): Promise<{ token: string; itemId: string }> {
  const { data } = await supabase.auth.setSession({ access_token: 'payer-tok', refresh_token: 'payer-tok' });
  const payerId = data.session!.user.id;

  const store = useBillStore.getState();
  const draftId = store.createDraftBill({ id: payerId, name: 'Alex' });
  store.addItem(draftId, { name: 'Pizza', priceCents: 2000 });
  const realId = await store.startManualEntry(draftId);
  store.confirmReview(realId);
  // Let the fire-and-forget `openBill` write-through (optimistic; see supabaseBillStore.ts)
  // actually land in the fake table before a guest's own read depends on `status`.
  await Promise.resolve();
  await Promise.resolve();

  const bill = useBillStore.getState().bills[realId];
  const itemId = bill.items.find((i) => i.name === 'Pizza')!.id;
  return { token: bill.shareToken!, itemId };
}

describe('public bill link (b/[token])', () => {
  beforeEach(() => {
    useBillStore.setState({ bills: {}, renamedBillIds: {}, syncErrors: {} });
  });

  it('lets a guest join by name, claim an item, and see their own total', async () => {
    const { token, itemId } = await createOpenBillWithOneItem();

    // A different browser/device: no session at all until the link itself starts one.
    await supabase.auth.signOut();

    renderRouter('./src/app', { initialUrl: `/b/${token}` });

    await typeInto('join-name-input', 'Riley');
    await press('join-button');

    await press(`claim-item-${itemId}`);

    await waitFor(() => expect(screen.getByTestId('my-total')).toHaveTextContent('$20.00'));
  });

  it('shows a read-only summary (no claim controls) to an existing member on a closed bill', async () => {
    const { data } = await supabase.auth.setSession({ access_token: 'payer-tok-2', refresh_token: 'payer-tok-2' });
    const payerId = data.session!.user.id;

    const store = useBillStore.getState();
    const draftId = store.createDraftBill({ id: payerId, name: 'Alex' });
    store.addItem(draftId, { name: 'Tacos', priceCents: 1500 });
    const realId = await store.startManualEntry(draftId);
    store.confirmReview(realId);
    await Promise.resolve();
    await Promise.resolve();

    // The payer closes the bill (M5's own close-bill control isn't built yet; writing `status`
    // directly through the store's data layer is the one way to get a closed bill to test
    // against without it).
    const bill = useBillStore.getState().bills[realId];
    await supabase.from('bills').update({ status: 'closed' }).eq('id', realId);

    // Same session reopening its own link - still a member, even though the bill is now closed.
    renderRouter('./src/app', { initialUrl: `/b/${bill.shareToken}` });

    await waitFor(() => expect(screen.getByTestId('closed-summary-banner')).toBeTruthy());
    expect(screen.queryByTestId(`claim-item-${bill.items[0].id}`)).toBeNull();
  });

  it('shows a clear not-found state for a token that matches no bill', async () => {
    await supabase.auth.signOut();

    renderRouter('./src/app', { initialUrl: '/b/not-a-real-token' });

    // A guest can't be told "not found" vs. "not yet a member" until they try to join (RLS
    // returns an empty result either way) - see supabaseBillStore.ts's own doc on this.
    await typeInto('join-name-input', 'Riley');
    await press('join-button');

    await waitFor(() => expect(screen.getByTestId('bill-not-found')).toBeTruthy());
  });
});

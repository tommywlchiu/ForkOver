/**
 * Review-screen edits driven through the real screens: a fee added in manual
 * entry can be labelled and priced and lands in the totals, and the tax input
 * shows the scanned tax once the stream finishes.
 */
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { useBillStore } from '../state/bill';
import { useSessionStore } from '../state/session';

// Fakes Supabase Auth/postgrest (see src/data/__mocks__/supabaseClient.ts) and the browser leg of
// the OAuth deep-link flow, so signing in doesn't need a network call or expo-sqlite's native
// module. The access token encodes the fake user id the mock client reads back.
jest.mock('../data/supabaseClient');
// Test-only reset hook the mock exports but the real module doesn't; accessed dynamically so
// tsc doesn't check it against the real module's type.
const { __resetFakeSupabase } = jest.requireMock('../data/supabaseClient') as {
  __resetFakeSupabase: () => void;
};
jest.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: jest.fn(),
  openAuthSessionAsync: jest.fn(async () => ({
    type: 'success',
    url: 'forkover://auth-callback#access_token=mock-access-test-user&refresh_token=mock-refresh-test-user&token_type=bearer',
  })),
}));

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ granted: true })),
  launchCameraAsync: jest.fn(async () => ({ canceled: false, assets: [{ uri: 'file://fake-receipt.jpg' }] })),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: false, assets: [{ uri: 'file://fake-receipt.jpg' }] })),
}));

jest.mock('../data/receiptReader', () => {
  const actual = jest.requireActual('../data/receiptReader');
  const { createStandInReader, INSTANT_STAND_IN_DELAYS } = jest.requireActual(
    '../lib/receipt/standIn/standInReader',
  );
  const { REALISTIC_RECEIPT } = jest.requireActual('../lib/receipt/standIn/scenarios');
  return {
    ...actual,
    getReceiptReader: () => {
      const reader = createStandInReader(REALISTIC_RECEIPT, INSTANT_STAND_IN_DELAYS);
      return () => reader();
    },
  };
});

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

describe('review edits', () => {
  beforeEach(async () => {
    useBillStore.setState({ bills: {} });
    await useSessionStore.getState().signOut();
    __resetFakeSupabase();
  });

  it('adds and edits a fee in manual entry and includes it in the totals', async () => {
    renderRouter('./src/app', { initialUrl: '/' });
    await signIn();
    await press('enter-manually-button');

    await typeInto('add-item-name-input', 'Pasta');
    await typeInto('add-item-price-input', '20.00');
    await press('add-item-button');

    await press('add-fee-button');
    const fee = onlyBill().fees[0];

    await typeInto(`fee-label-${fee.id}`, 'Service charge');
    await fireEvent(await screen.findByTestId(`fee-amount-${fee.id}`), 'endEditing', {
      nativeEvent: { text: '3.50' },
    });

    await waitFor(() => {
      const [stored] = onlyBill().fees;
      expect(stored.label).toBe('Service charge');
      expect(stored.cents).toBe(350);
    });
    expect(screen.getByDisplayValue('Service charge')).toBeTruthy();
    expect(screen.getByDisplayValue('3.50')).toBeTruthy();

    const split = useBillStore.getState().getSplit(onlyBill().id);
    expect(split?.ok && split.totals.feesCents).toBe(350);
    expect(split?.ok && split.totals.grandTotalCents).toBe(2350);
  });

  it('shows the scanned tax in the tax input once the scan finishes', async () => {
    renderRouter('./src/app', { initialUrl: '/' });
    await signIn();
    await press('scan-receipt-button');
    await press('consent-allow-button');
    await press('shutter-button');

    await waitFor(() => expect(onlyBill().scanState).toBe('done'));
    const { taxCents } = onlyBill();
    expect(taxCents).toBeGreaterThan(0);

    await waitFor(() => expect(screen.getByTestId('tax-input').props.defaultValue).toBe((taxCents / 100).toFixed(2)));
  });
});

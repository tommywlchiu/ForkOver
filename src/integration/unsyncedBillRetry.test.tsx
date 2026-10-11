/**
 * Drives a failed promotion through the real screens (SPEC.md section 8.3, M4; code review on
 * PR #31): when `create_manual_bill` fails, the payer sees a persistent "not synced" state (not
 * just a one-off toast) on review.tsx, and tapping Retry gets them a real, synced bill.
 */
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { useBillStore } from '../state/bill';

jest.mock('../data/supabaseClient');
const { __resetFakeSupabase, __forceNextRpcError } = jest.requireMock('../data/supabaseClient') as {
  __resetFakeSupabase: () => void;
  __forceNextRpcError: (message?: string) => void;
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

describe('a failed promotion shows a persistent, retryable "not synced" state', () => {
  beforeEach(() => {
    useBillStore.setState({ bills: {}, renamedBillIds: {}, syncErrors: {}, unsyncedBillIds: {} });
    __resetFakeSupabase();
  });

  it('shows Retry on review.tsx when create_manual_bill fails, and resolves on retry', async () => {
    __forceNextRpcError('network unreachable');
    renderRouter('./src/app', { initialUrl: '/' });

    await press('sign-in-google-button');
    await typeInto('username-input', 'alex');
    await press('username-continue-button');

    await press('enter-manually-button');

    await screen.findByTestId('bill-not-synced');
    expect(screen.getByText("This bill hasn't saved yet.")).toBeTruthy();

    const billId = Object.keys(useBillStore.getState().bills)[0];
    expect(useBillStore.getState().unsyncedBillIds[billId]).toBe(true);

    await press('retry-sync-button');

    await waitFor(() => expect(screen.queryByTestId('bill-not-synced')).toBeNull());
    await waitFor(() => expect(useBillStore.getState().unsyncedBillIds[billId]).toBeUndefined());
    // The bill is now rekeyed to its real server id.
    expect(Object.keys(useBillStore.getState().bills)).not.toContain(billId);
  }, 15000);
});

/**
 * Finishes the offline-banner wiring (SPEC.md section 8.3, M4): the earlier offline-detection
 * task only built the connectivity store and the banner component, not screen integration. Drives
 * the real bill screen and flips `useConnectivityStore` to prove the banner shows, claim/edit
 * controls disable, and reconnecting re-enables them.
 */
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { useBillStore } from '../state/bill';
import { useConnectivityStore } from '../state/connectivity';

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

function onlyBillId(): string {
  const ids = Object.keys(useBillStore.getState().bills);
  if (ids.length !== 1) throw new Error(`expected exactly one bill, found ${ids.length}`);
  return ids[0];
}

describe('offline banner wiring on the bill screen', () => {
  beforeEach(() => {
    useBillStore.setState({ bills: {}, renamedBillIds: {}, syncErrors: {} });
    useConnectivityStore.setState({ isConnected: true, isInitialized: true });
  });

  it('disables claim controls while disconnected and re-enables them on reconnect', async () => {
    renderRouter('./src/app', { initialUrl: '/' });

    await press('sign-in-google-button');
    await typeInto('username-input', 'alex');
    await press('username-continue-button');

    await press('enter-manually-button');
    await typeInto('add-item-name-input', 'Pizza');
    await typeInto('add-item-price-input', '20.00');
    await press('add-item-button');
    await press('looks-right-button');
    await press('go-to-bill-button');

    const billId = onlyBillId();
    const itemId = useBillStore.getState().bills[billId].items[0].id;

    expect(screen.queryByTestId('no-connection-banner')).toBeNull();
    await waitFor(() => expect(screen.getByTestId(`claim-item-${itemId}`).props.accessibilityState.disabled).toBe(false));

    useConnectivityStore.setState({ isConnected: false });

    await waitFor(() => expect(screen.getByTestId('no-connection-banner')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId(`claim-item-${itemId}`).props.accessibilityState.disabled).toBe(true));
    expect(screen.getByTestId('add-person-button').props.accessibilityState.disabled).toBe(true);

    useConnectivityStore.setState({ isConnected: true });

    await waitFor(() => expect(screen.queryByTestId('no-connection-banner')).toBeNull());
    await waitFor(() => expect(screen.getByTestId(`claim-item-${itemId}`).props.accessibilityState.disabled).toBe(false));
  }, 15000);
});

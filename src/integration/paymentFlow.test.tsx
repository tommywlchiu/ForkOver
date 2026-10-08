/**
 * Drives the realistic-receipt scenario from split.test.ts through the actual
 * screens (via testIDs), end to end: sign in, username, consent, scan,
 * review, tip, send, then claim items for named people and confirm the
 * totals show $25.12, $35.99, $22.53 (SPEC.md section 11, M3 checkpoint).
 *
 * @testing-library/react-native v14's `fireEvent` is async (it awaits React's
 * `act()` internally), so every fireEvent call here is awaited; skipping that
 * leaves the resulting state update unflushed when the next line runs.
 */
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { useBillStore } from '../state/bill';
import { useSessionStore } from '../state/session';

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ granted: true })),
  launchCameraAsync: jest.fn(async () => ({ canceled: false, assets: [{ uri: 'file://fake-receipt.jpg' }] })),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: false, assets: [{ uri: 'file://fake-receipt.jpg' }] })),
}));

// Same stand-in scenario, with the streaming delays collapsed so the test is instant.
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

function currentBillId(): string {
  const ids = Object.keys(useBillStore.getState().bills);
  if (ids.length !== 1) throw new Error(`expected exactly one bill, found ${ids.length}`);
  return ids[0];
}

function itemIdFor(billId: string, name: string): string {
  const item = useBillStore.getState().bills[billId].items.find((i) => i.name === name);
  if (!item) throw new Error(`no item named "${name}"`);
  return item.id;
}

async function press(testID: string) {
  await fireEvent.press(await screen.findByTestId(testID));
}

async function typeInto(testID: string, text: string) {
  await fireEvent.changeText(await screen.findByTestId(testID), text);
}

describe('payer flow: scan to claimed totals', () => {
  // This drives the full screen flow end to end; bump past the 5000ms default so it
  // doesn't time out under CI/parallel-test contention (SPEC.md section 11, M3 checkpoint).
  it('reproduces the realistic-receipt split ($25.12 / $35.99 / $22.53)', async () => {
    renderRouter('./src/app', { initialUrl: '/' });

    // Sign in (stand-in) and pick a username.
    await press('sign-in-apple-button');
    await typeInto('username-input', 'alex');
    await press('username-continue-button');

    // Home: start a scan, which prompts for AI consent first.
    await press('scan-receipt-button');
    await press('consent-allow-button');

    // Scan: shutter press starts the (stand-in) stream, then Review takes over.
    await press('shutter-button');

    // Review: items stream in, the merchant name lands once the scan finishes.
    await waitFor(() => expect(screen.getByText('Sakura Izakaya')).toBeTruthy());
    const billId = currentBillId();
    await waitFor(() => expect(useBillStore.getState().bills[billId].scanState).toBe('done'));
    // A successful scan counts against the free-tier quota (SPEC 7.1 step 5).
    expect(useSessionStore.getState().scansUsedThisMonth).toBe(1);

    expect(screen.getByDisplayValue('Ramen')).toBeTruthy();
    expect(screen.getByDisplayValue('Katsu')).toBeTruthy();
    expect(screen.getByDisplayValue('Gyoza')).toBeTruthy();
    expect(screen.getByDisplayValue('Beer')).toBeTruthy();
    expect(screen.getByDisplayValue('Sake')).toBeTruthy();

    // The receipt printed no tip; pick the 20% pre-tax chip (the default base).
    await press('tip-chip-20');
    await press('looks-right-button');

    // Share: move on to the bill screen without sending (sending is exercised elsewhere).
    await press('go-to-bill-button');
    await screen.findByTestId('add-person-button');

    const ramenId = itemIdFor(billId, 'Ramen');
    const katsuId = itemIdFor(billId, 'Katsu');
    const gyozaId = itemIdFor(billId, 'Gyoza');
    const beerId = itemIdFor(billId, 'Beer');
    const sakeId = itemIdFor(billId, 'Sake');

    // Claiming as the payer (Alex, active by default): ramen, and a share of gyoza.
    await press(`claim-item-${ramenId}`);
    await press(`share-item-${gyozaId}`);

    // Add Bailey (becomes the active claimer) and claim on her behalf.
    await press('add-person-button');
    await typeInto('add-person-name-input', 'Bailey');
    await press('confirm-add-person-button');

    await press(`claim-item-${katsuId}`);
    await press(`share-item-${gyozaId}`);
    await press(`share-item-${sakeId}`);

    // Add Casey and claim on her behalf.
    await press('add-person-button');
    await typeInto('add-person-name-input', 'Casey');
    await press('confirm-add-person-button');

    await press(`claim-item-${beerId}`);
    await press(`share-item-${gyozaId}`);
    await press(`share-item-${sakeId}`);

    const people = useBillStore.getState().bills[billId].people;
    const alexId = people.find((p) => p.kind === 'payer')!.id;
    const baileyId = people.find((p) => p.name === 'Bailey')!.id;
    const caseyId = people.find((p) => p.name === 'Casey')!.id;

    await waitFor(() => {
      expect(screen.getByTestId(`person-total-${alexId}`)).toHaveTextContent('$25.12');
      expect(screen.getByTestId(`person-total-${baileyId}`)).toHaveTextContent('$35.99');
      expect(screen.getByTestId(`person-total-${caseyId}`)).toHaveTextContent('$22.53');
    });
  }, 15000);
});

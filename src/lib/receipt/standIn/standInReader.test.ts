import { createStandInReader, INSTANT_STAND_IN_DELAYS } from './standInReader';
import { REALISTIC_RECEIPT } from './scenarios';
import type { ParseEvent } from '../parseReceipt';

async function collect(gen: AsyncGenerator<ParseEvent>): Promise<ParseEvent[]> {
  const events: ParseEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe('createStandInReader', () => {
  it('yields one item event per receipt item, then a done event carrying the receipt', async () => {
    const reader = createStandInReader(REALISTIC_RECEIPT, INSTANT_STAND_IN_DELAYS);
    const events = await collect(reader());

    expect(events).toHaveLength(REALISTIC_RECEIPT.items.length + 1);
    events.slice(0, -1).forEach((event, index) => {
      expect(event).toEqual({ type: 'item', ...REALISTIC_RECEIPT.items[index] });
    });
    const last = events[events.length - 1];
    expect(last.type).toBe('done');
    expect(last.type === 'done' && last.receipt).toEqual(REALISTIC_RECEIPT);
  });

  it('waits between items using the given delays', async () => {
    jest.useFakeTimers();
    const reader = createStandInReader(REALISTIC_RECEIPT, { perItemMs: 100, tailMs: 50 });
    const gen = reader();

    const firstPromise = gen.next();
    await jest.advanceTimersByTimeAsync(100);
    const first = await firstPromise;
    expect(first.value).toEqual({ type: 'item', ...REALISTIC_RECEIPT.items[0] });

    jest.useRealTimers();
  });
});

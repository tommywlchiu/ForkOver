/**
 * Claim resolution contract tests (new in revision 2, aligned with the ForkOver PRD).
 *
 * These tests ARE the spec for src/lib/claims/resolve.ts. The implementation must
 * make them pass without editing this file. If a test looks wrong, stop and ask
 * the human instead of changing the expectation.
 *
 * resolveClaims() turns the live claim state of a bill into each item's effective
 * assignees, which then feed calculateSplit(). Rules (see SPEC.md section 6.2):
 *  - A payer assignment with at least one person wins over all claims (FR-12, FR-14).
 *  - No claims: unclaimed, assignedTo [] (the split engine puts it on the payer, FR-13).
 *  - One claimant, in either mode: claimed by that person alone.
 *  - Two or more claimants, all "shared": split equally among them (FR-8).
 *  - Two or more claimants, any "mine": conflict, provisionally split equally among
 *    all claimants until the payer resolves it (FR-14, FR-15).
 *  - Claims are keyed by (itemId, personId); a later entry replaces an earlier one.
 *  - Who made the claim (createdBy) never matters, so the payer can claim on
 *    anyone's behalf (FR-32).
 *  - assignedTo lists people in the order of their first claim on that item.
 *
 * Runs under jest-expo (Jest globals) or Vitest with globals enabled.
 */
import { resolveClaims, type Claim, type PayerAssignment } from './resolve';

const mine = (itemId: string, personId: string, createdBy = personId): Claim => ({
  itemId,
  personId,
  mode: 'mine',
  createdBy,
});

const shared = (itemId: string, personId: string, createdBy = personId): Claim => ({
  itemId,
  personId,
  mode: 'shared',
  createdBy,
});

const resolve = (itemIds: string[], claims: Claim[], assignments: PayerAssignment[] = []) =>
  resolveClaims({ itemIds, claims, assignments });

describe('resolveClaims', () => {
  it('returns one entry per item, in the order given', () => {
    const out = resolve(['b', 'a', 'c'], []);
    expect(out.map((r) => r.itemId)).toEqual(['b', 'a', 'c']);
  });

  it('marks an item with no claims as unclaimed with no assignees', () => {
    expect(resolve(['calamari'], [])).toEqual([
      { itemId: 'calamari', assignedTo: [], state: 'unclaimed' },
    ]);
  });

  it('gives an item claimed as mine by one person to that person', () => {
    expect(resolve(['ramen'], [mine('ramen', 'alex')])).toEqual([
      { itemId: 'ramen', assignedTo: ['alex'], state: 'claimed' },
    ]);
  });

  it('gives a shared item with only one claimant so far to that person alone', () => {
    expect(resolve(['gyoza'], [shared('gyoza', 'alex')])).toEqual([
      { itemId: 'gyoza', assignedTo: ['alex'], state: 'claimed' },
    ]);
  });

  it('splits an item among everyone who claimed it as shared', () => {
    const out = resolve(['gyoza'], [shared('gyoza', 'alex'), shared('gyoza', 'sam'), shared('gyoza', 'kim')]);
    expect(out).toEqual([{ itemId: 'gyoza', assignedTo: ['alex', 'sam', 'kim'], state: 'shared' }]);
  });

  it('flags two "mine" claims as a conflict and splits provisionally', () => {
    const out = resolve(['steak'], [mine('steak', 'alex'), mine('steak', 'sam')]);
    expect(out).toEqual([{ itemId: 'steak', assignedTo: ['alex', 'sam'], state: 'conflict' }]);
  });

  it('flags a "mine" claim mixed with a "shared" claim as a conflict', () => {
    const out = resolve(['nachos'], [shared('nachos', 'alex'), mine('nachos', 'sam')]);
    expect(out).toEqual([{ itemId: 'nachos', assignedTo: ['alex', 'sam'], state: 'conflict' }]);
  });

  it('lets a later claim by the same person replace their earlier one', () => {
    const out = resolve(['nachos'], [
      mine('nachos', 'alex'),
      shared('nachos', 'sam'),
      shared('nachos', 'alex'), // alex changes "mine" to "shared", so no conflict remains
    ]);
    expect(out).toEqual([{ itemId: 'nachos', assignedTo: ['alex', 'sam'], state: 'shared' }]);
  });

  it('lists assignees in order of their first claim', () => {
    const out = resolve(['fries'], [shared('fries', 'kim'), shared('fries', 'alex'), shared('fries', 'kim')]);
    expect(out[0].assignedTo).toEqual(['kim', 'alex']);
  });

  it('lets a payer assignment override every claim, including a conflict', () => {
    const out = resolve(
      ['steak'],
      [mine('steak', 'alex'), mine('steak', 'sam')],
      [{ itemId: 'steak', assignedTo: ['sam'] }],
    );
    expect(out).toEqual([{ itemId: 'steak', assignedTo: ['sam'], state: 'assigned' }]);
  });

  it('lets the payer assign or split an unclaimed item', () => {
    const out = resolve(['calamari'], [], [{ itemId: 'calamari', assignedTo: ['alex', 'kim', 'alex'] }]);
    expect(out).toEqual([{ itemId: 'calamari', assignedTo: ['alex', 'kim'], state: 'assigned' }]);
  });

  it('uses the latest payer assignment when there are several for one item', () => {
    const out = resolve(
      ['wine'],
      [],
      [
        { itemId: 'wine', assignedTo: ['alex'] },
        { itemId: 'wine', assignedTo: ['sam'] },
      ],
    );
    expect(out[0].assignedTo).toEqual(['sam']);
  });

  it('ignores an empty payer assignment and falls back to the claims', () => {
    const out = resolve(['wine'], [mine('wine', 'kim')], [{ itemId: 'wine', assignedTo: [] }]);
    expect(out).toEqual([{ itemId: 'wine', assignedTo: ['kim'], state: 'claimed' }]);
  });

  it('treats a claim the payer made on a friend\'s behalf like any other claim (FR-32)', () => {
    const out = resolve(['dumplings'], [mine('dumplings', 'grandma', 'payer')]);
    expect(out).toEqual([{ itemId: 'dumplings', assignedTo: ['grandma'], state: 'claimed' }]);
  });

  it('ignores claims and assignments for items that are not on the bill', () => {
    const out = resolve(['a'], [mine('ghost', 'alex')], [{ itemId: 'ghost', assignedTo: ['sam'] }]);
    expect(out).toEqual([{ itemId: 'a', assignedTo: [], state: 'unclaimed' }]);
  });

  it('keeps each item independent of the others', () => {
    const out = resolve(
      ['x', 'y'],
      [mine('x', 'alex'), mine('x', 'sam'), shared('y', 'alex'), shared('y', 'sam')],
    );
    expect(out.map((r) => r.state)).toEqual(['conflict', 'shared']);
  });
});

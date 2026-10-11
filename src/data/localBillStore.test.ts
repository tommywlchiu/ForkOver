import { createLocalBillStore } from './localBillStore';
import { REALISTIC_RECEIPT } from '../lib/receipt/standIn/scenarios';

describe('createLocalBillStore', () => {
  it('creates a draft bill with the payer as its first person', () => {
    const store = createLocalBillStore();
    const bill = store.createDraftBill({ id: 'payer-1', name: 'Alex' });
    expect(bill.status).toBe('draft');
    expect(bill.payerId).toBe('payer-1');
    expect(bill.people).toEqual([{ id: 'payer-1', name: 'Alex', kind: 'payer' }]);
    expect(store.getBill(bill.id)).toBe(bill);
  });

  it('expands a streamed quantity line into unit items that sum to the line total', () => {
    const store = createLocalBillStore();
    const bill = store.createDraftBill({ id: 'p1', name: 'Alex' });
    const added = store.addStreamedLine(bill.id, { name: 'Draft Beer', quantity: 2, lineTotalCents: 1700 });
    expect(added.map((i) => i.priceCents)).toEqual([850, 850]);
    expect(store.getBill(bill.id)!.items).toHaveLength(2);
  });

  it('finalizes a scan with the receipt totals, tip, fees, and warnings', () => {
    const store = createLocalBillStore();
    const bill = store.createDraftBill({ id: 'p1', name: 'Alex' });
    store.beginScan(bill.id);
    for (const line of REALISTIC_RECEIPT.items) store.addStreamedLine(bill.id, line);
    store.finalizeScan(bill.id, REALISTIC_RECEIPT);

    const updated = store.getBill(bill.id)!;
    expect(updated.scanState).toBe('done');
    expect(updated.merchantName).toBe('Sakura Izakaya');
    expect(updated.taxCents).toBe(576);
    expect(updated.tip).toEqual({ kind: 'amount', cents: 0 });
    expect(updated.tipSource).toBeNull();
    expect(updated.printedSubtotalCents).toBe(6490);
    expect(updated.items.map((i) => i.priceCents)).toEqual([1650, 1895, 895, 850, 1200]);
  });

  it('marks a scan failed with an error code', () => {
    const store = createLocalBillStore();
    const bill = store.createDraftBill({ id: 'p1', name: 'Alex' });
    store.failScan(bill.id, 'UPSTREAM_ERROR');
    expect(store.getBill(bill.id)!.scanState).toBe('error');
    expect(store.getBill(bill.id)!.scanError).toBe('UPSTREAM_ERROR');
  });

  it('adds, edits, and removes manual items, clearing claims on removal', () => {
    const store = createLocalBillStore();
    const bill = store.createDraftBill({ id: 'p1', name: 'Alex' });
    const item = store.addItem(bill.id, { name: 'Nachos', priceCents: 900 });
    store.setClaim(bill.id, item.id, 'p1', 'mine', 'p1');
    store.updateItem(bill.id, item.id, { priceCents: 950 });
    expect(store.getBill(bill.id)!.items[0].priceCents).toBe(950);

    store.removeItem(bill.id, item.id);
    expect(store.getBill(bill.id)!.items).toEqual([]);
    expect(store.getBill(bill.id)!.claims).toEqual([]);
  });

  it('merges items back into one, summing price and dropping their claims', () => {
    const store = createLocalBillStore();
    const bill = store.createDraftBill({ id: 'p1', name: 'Alex' });
    const a = store.addItem(bill.id, { name: 'Beer', priceCents: 850 });
    const b = store.addItem(bill.id, { name: 'Beer', priceCents: 850 });
    store.setClaim(bill.id, a.id, 'p1', 'mine', 'p1');

    store.mergeItems(bill.id, [a.id, b.id]);

    const merged = store.getBill(bill.id)!;
    expect(merged.items).toHaveLength(1);
    expect(merged.items[0]).toMatchObject({ name: 'Beer', priceCents: 1700 });
    expect(merged.claims).toEqual([]);
  });

  it('suffixes a duplicate guest/person name instead of colliding', () => {
    const store = createLocalBillStore();
    const bill = store.createDraftBill({ id: 'p1', name: 'Alex' });
    store.addPerson(bill.id, 'Sam');
    const second = store.addPerson(bill.id, 'Sam');
    expect(second.name).toBe('Sam (2)');
  });

  it('sets and clears claims, keyed by (itemId, personId), latest wins', () => {
    const store = createLocalBillStore();
    const bill = store.createDraftBill({ id: 'p1', name: 'Alex' });
    const item = store.addItem(bill.id, { name: 'Ramen', priceCents: 1650 });
    store.addPerson(bill.id, 'Bailey');

    store.setClaim(bill.id, item.id, 'p1', 'mine', 'p1');
    expect(store.getBill(bill.id)!.claims).toEqual([{ itemId: item.id, personId: 'p1', mode: 'mine', createdBy: 'p1' }]);

    store.setClaim(bill.id, item.id, 'p1', 'shared', 'p1');
    expect(store.getBill(bill.id)!.claims).toHaveLength(1);
    expect(store.getBill(bill.id)!.claims[0].mode).toBe('shared');

    store.clearClaim(bill.id, item.id, 'p1');
    expect(store.getBill(bill.id)!.claims).toEqual([]);
  });

  it('opens and marks a bill sent', () => {
    const store = createLocalBillStore();
    const bill = store.createDraftBill({ id: 'p1', name: 'Alex' });
    expect(store.getBill(bill.id)!.status).toBe('draft');
    store.openBill(bill.id);
    expect(store.getBill(bill.id)!.status).toBe('open');
    expect(store.getBill(bill.id)!.sentAt).toBeNull();
    store.markSent(bill.id);
    expect(store.getBill(bill.id)!.sentAt).not.toBeNull();
  });

  it('promotes a draft to a given server id, rekeying it in place', async () => {
    const store = createLocalBillStore();
    const bill = store.createDraftBill({ id: 'p1', name: 'Alex' });
    store.addItem(bill.id, { name: 'Nachos', priceCents: 900 });

    const promoted = await store.promoteBill(bill.id, { id: 'p1', name: 'Alex' }, 'server-bill-1');
    expect(promoted.id).toBe('server-bill-1');
    expect(promoted.items).toHaveLength(1);
    expect(store.getBill(bill.id)).toBeUndefined();
    expect(store.getBill('server-bill-1')).toBe(promoted);
  });

  it('promotes a draft to a fresh local id when none is given', async () => {
    const store = createLocalBillStore();
    const bill = store.createDraftBill({ id: 'p1', name: 'Alex' });
    const promoted = await store.promoteBill(bill.id, { id: 'p1', name: 'Alex' });
    expect(promoted.id).not.toBe(bill.id);
    expect(store.getBill(bill.id)).toBeUndefined();
  });

  it('lists bills newest first, even when created in the same millisecond', () => {
    const store = createLocalBillStore();
    const first = store.createDraftBill({ id: 'p1', name: 'Alex' });
    const second = store.createDraftBill({ id: 'p1', name: 'Alex' });
    expect(store.listBills().map((b) => b.id)).toEqual([second.id, first.id]);
  });
});

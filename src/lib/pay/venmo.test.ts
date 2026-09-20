import { buildVenmoPayLink } from './venmo';

describe('buildVenmoPayLink', () => {
  it('builds a pay link with dollars to two decimals', () => {
    const link = buildVenmoPayLink({
      username: 'alice',
      amountCents: 2253,
      note: 'ForkOver: Sushi night',
    });
    expect(link).toBe('https://venmo.com/alice?txn=pay&amount=22.53&note=ForkOver%3A%20Sushi%20night');
  });

  it('strips a leading @ from the username', () => {
    const link = buildVenmoPayLink({ username: '@alice', amountCents: 100, note: 'ForkOver: Lunch' });
    expect(link).toContain('venmo.com/alice?');
  });

  it('URL-encodes a username with special characters', () => {
    const link = buildVenmoPayLink({ username: 'a b', amountCents: 100, note: 'x' });
    expect(link).toContain('venmo.com/a%20b?');
  });

  it('pads whole-dollar amounts to two decimals', () => {
    const link = buildVenmoPayLink({ username: 'bob', amountCents: 500, note: 'x' });
    expect(link).toContain('amount=5.00');
  });

  it('throws for a zero amount', () => {
    expect(() => buildVenmoPayLink({ username: 'bob', amountCents: 0, note: 'x' })).toThrow();
  });

  it('throws for a negative amount', () => {
    expect(() => buildVenmoPayLink({ username: 'bob', amountCents: -100, note: 'x' })).toThrow();
  });

  it('throws for a non-integer amount', () => {
    expect(() => buildVenmoPayLink({ username: 'bob', amountCents: 12.5, note: 'x' })).toThrow();
  });
});

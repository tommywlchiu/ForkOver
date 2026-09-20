/**
 * Venmo pay links. See SPEC.md section 6.6.
 *
 * The caller composes `note` (`ForkOver: <bill title>`) and decides when to
 * render the button (USD bill, payer has a Venmo username, positive
 * remaining balance) — this stays a one-line link builder so a format
 * change is a one-line fix.
 */
export function buildVenmoPayLink(input: {
  username: string;
  amountCents: number;
  note: string;
}): string {
  const { username, amountCents, note } = input;
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`buildVenmoPayLink: amountCents must be a positive integer, got ${amountCents}`);
  }

  const cleanUsername = username.replace(/^@+/, '');
  const amount = (amountCents / 100).toFixed(2);
  return `https://venmo.com/${encodeURIComponent(cleanUsername)}?txn=pay&amount=${amount}&note=${encodeURIComponent(note)}`;
}

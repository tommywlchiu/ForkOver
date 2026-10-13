/**
 * How a person's name is annotated on a bill screen (SPEC.md 2.3, 2.4): the payer's own bill
 * screen and the public claim link both need this, and had drifted into two slightly different,
 * copy-pasted rules ("(you)" on the payer's screen, "(payer)" on the claim link) before this was
 * factored out. One rule for both: the viewer's own row always reads "(you)" - on the payer's own
 * screen that's also always the payer (so this is the same text that was always shown there); on
 * the claim link, everyone else sees the payer's row as "(payer)", and a non-payer viewer sees no
 * special label on anyone else's row.
 */
export function personDisplayName(input: { name: string; personId: string; payerId: string; viewerPersonId: string }): string {
  const { name, personId, payerId, viewerPersonId } = input;
  if (personId === viewerPersonId) return `${name} (you)`;
  if (personId === payerId) return `${name} (payer)`;
  return name;
}

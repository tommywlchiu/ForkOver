/**
 * Claim resolution: turns a bill's live claim state into each item's effective
 * assignees, which then feed calculateSplit(). See SPEC.md section 6.2.
 */

export type ClaimMode = 'mine' | 'shared';

export type Claim = {
  itemId: string;
  personId: string;
  mode: ClaimMode;
  createdBy: string;
};

export type PayerAssignment = { itemId: string; assignedTo: string[] };

export type ItemClaimState = 'unclaimed' | 'claimed' | 'shared' | 'conflict' | 'assigned';

export type ResolvedItem = { itemId: string; assignedTo: string[]; state: ItemClaimState };

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

export function resolveClaims(input: {
  itemIds: string[];
  claims: Claim[];
  assignments: PayerAssignment[];
}): ResolvedItem[] {
  const { itemIds, claims, assignments } = input;
  const onBill = new Set(itemIds);

  const latestAssignment = new Map<string, string[]>();
  for (const assignment of assignments) {
    if (!onBill.has(assignment.itemId)) continue;
    latestAssignment.set(assignment.itemId, assignment.assignedTo);
  }

  // Map.set on an existing key updates the mode while keeping the person's
  // original insertion order, which is what orders assignedTo by first claim.
  const claimsByItem = new Map<string, Map<string, ClaimMode>>();
  for (const claim of claims) {
    if (!onBill.has(claim.itemId)) continue;
    let byPerson = claimsByItem.get(claim.itemId);
    if (!byPerson) {
      byPerson = new Map<string, ClaimMode>();
      claimsByItem.set(claim.itemId, byPerson);
    }
    byPerson.set(claim.personId, claim.mode);
  }

  return itemIds.map((itemId): ResolvedItem => {
    const assigned = latestAssignment.get(itemId);
    if (assigned && assigned.length > 0) {
      return { itemId, assignedTo: dedupe(assigned), state: 'assigned' };
    }

    const byPerson = claimsByItem.get(itemId);
    if (!byPerson || byPerson.size === 0) {
      return { itemId, assignedTo: [], state: 'unclaimed' };
    }

    const assignedTo = [...byPerson.keys()];
    if (assignedTo.length === 1) {
      return { itemId, assignedTo, state: 'claimed' };
    }

    const anyMine = [...byPerson.values()].some((mode) => mode === 'mine');
    return { itemId, assignedTo, state: anyMine ? 'conflict' : 'shared' };
  });
}

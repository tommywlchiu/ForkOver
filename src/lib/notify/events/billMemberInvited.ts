/**
 * SPEC.md 8.7: "To a member, when the payer sends them a bill in the app." Fired for
 * `event_type = 'bill_member_invited'` (queued by `invite_bill_member`, see
 * supabase/migrations/20261013000100_invite_bill_member_notify.sql). Deliberately generic text,
 * not the bill's title or who sent it (SPEC 8.8's privacy stance extends to push payloads too -
 * AGENTS.md/the M4 notify task brief).
 */
import type { EventNotification, NotificationEventRecord } from '../types.ts';

export const EVENT_TYPE = 'bill_member_invited';

export function buildNotification(_record: NotificationEventRecord): EventNotification {
  return {
    title: 'New bill',
    body: "You've been added to a bill.",
  };
}

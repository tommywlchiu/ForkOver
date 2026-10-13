/**
 * `event_type` -> builder, one entry per SPEC 8.7 trigger. Add the M5 triggers ("a claim creates
 * a conflict", "the last unclaimed item gets claimed or assigned") here the same way, each as its
 * own file under events/ - this registry, handler.ts, and the webhook migration don't change.
 */
import { EVENT_TYPE as BILL_MEMBER_INVITED, buildNotification as buildBillMemberInvited } from './events/billMemberInvited.ts';
import type { EventNotification, NotificationEventRecord } from './types.ts';

type EventBuilder = (record: NotificationEventRecord) => EventNotification;

export const EVENT_BUILDERS: Record<string, EventBuilder> = {
  [BILL_MEMBER_INVITED]: buildBillMemberInvited,
};

/**
 * Shared types for the `notify` Edge Function (SPEC.md 8.7). Deno-imported (see
 * supabase/functions/notify/index.ts), so this file has no dependencies and uses explicit `.ts`
 * import extensions, like src/lib/receipt's Deno-imported files (AGENTS.md "Edge Functions").
 */

/** One row of `notification_events` (supabase/migrations/20261013000000_notification_events.sql). */
export type NotificationEventRecord = {
  id: string;
  event_type: string;
  bill_id: string;
  recipient_user_id: string;
  payload: Record<string, unknown>;
  created_at: string;
};

/** Supabase's fixed database-webhook payload shape (`{type, table, schema, record, old_record}`). */
export type NotifyWebhookPayload = {
  type: string;
  table: string;
  schema: string;
  record: NotificationEventRecord;
  old_record: NotificationEventRecord | null;
};

/** One Expo Push API message (https://docs.expo.dev/push-notifications/sending-notifications/). */
export type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  data: { billId: string };
};

/** The message text for one event type, built with no bill/receipt contents (SPEC 8.8's privacy stance). */
export type EventNotification = {
  title: string;
  body: string;
};

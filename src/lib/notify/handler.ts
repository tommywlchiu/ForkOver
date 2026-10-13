/**
 * The `notify` Edge Function's request handling (SPEC.md 8.7): everything that touches Supabase
 * or the Expo Push API comes in through `NotifyDeps`, so this file has no I/O of its own and
 * tests need neither a database nor a network call - the same split as src/lib/receipt/handler.ts.
 */
import { EVENT_BUILDERS } from './registry.ts';
import type { ExpoPushMessage, NotificationEventRecord, NotifyWebhookPayload } from './types.ts';

export type NotifyDeps = {
  /** This recipient's current Expo push tokens (`push_tokens`, one row per device). */
  fetchPushTokens(userId: string): Promise<string[]>;
  /** POSTs to the Expo Push API. Expected to throw on a non-2xx response or network failure. */
  sendExpoPush(messages: ExpoPushMessage[]): Promise<void>;
};

/**
 * Builds one Expo push message per token (fan-out to every device), or `[]` when there is
 * nothing to send: no tokens, or an `event_type` with no registered builder (a future SPEC 8.7
 * trigger whose code hasn't shipped yet - skipped, not an error, so an old `notify` deployment
 * never crashes on a new event type a newer migration starts queuing).
 */
export function buildExpoMessages(record: NotificationEventRecord, tokens: string[]): ExpoPushMessage[] {
  const builder = EVENT_BUILDERS[record.event_type];
  if (!builder || tokens.length === 0) return [];
  const { title, body } = builder(record);
  return tokens.map((token) => ({ to: token, title, body, data: { billId: record.bill_id } }));
}

/**
 * Only ever an insert on `notification_events` in practice (the one trigger wired up so far), but
 * checks the shape anyway rather than assuming the webhook payload is always this.
 */
export function isNotificationEventInsert(payload: NotifyWebhookPayload): boolean {
  return payload.type === 'INSERT' && payload.table === 'notification_events' && payload.record != null;
}

/**
 * Looks up tokens and sends. Never throws: a failed send (stale/invalid token, Expo API error,
 * network failure) is logged and dropped rather than crashing the webhook or retrying - `notify`
 * runs from a database trigger that doesn't expect a response body, and a stale token is
 * `push_tokens`' problem to prune, not this function's (M4 notify task brief; that pruning job is
 * a separate, not-yet-built gap).
 */
export async function handleNotifyWebhook(payload: NotifyWebhookPayload, deps: NotifyDeps): Promise<void> {
  if (!isNotificationEventInsert(payload)) return;

  const { record } = payload;
  const tokens = await deps.fetchPushTokens(record.recipient_user_id);
  const messages = buildExpoMessages(record, tokens);
  if (messages.length === 0) return;

  try {
    await deps.sendExpoPush(messages);
  } catch (err) {
    console.error('notify: failed to send push notification', err);
  }
}

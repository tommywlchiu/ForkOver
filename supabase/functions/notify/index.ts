/**
 * `notify` Edge Function (SPEC.md 8.7). Thin wiring only: the logic is in src/lib/notify so it is
 * unit tested under jest. Only ever called by the `notification_events` database webhook
 * (supabase/migrations/20261013000200_notify_webhook.sql), never a client directly - see that
 * migration's comment, and config.toml's `[functions.notify] verify_jwt = false` (there is no
 * signed-in user's JWT to check here).
 *
 * Because there's no JWT to verify, this function's URL is otherwise exactly as reachable as
 * `parse-receipt`'s (same project ref, already public in the shipped app's `SUPABASE_URL`) - a
 * caller who extracted it could POST a fake `{record: {...}}` body directly and get an arbitrary
 * user an arbitrary push, with no auth and no rate limit. `NOTIFY_WEBHOOK_SECRET` guards against
 * exactly that: the webhook migration sets it as a header on every real call, and any request
 * missing or mismatching it is rejected before the body is even parsed.
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform, same as parse-receipt.
 */
import { createClient } from '@supabase/supabase-js';
import { handleNotifyWebhook, type NotifyDeps } from '../../../src/lib/notify/handler.ts';
import type { NotifyWebhookPayload } from '../../../src/lib/notify/types.ts';
import { createNotifyPorts } from './ports.ts';

const requireEnv = (name: string): string => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`notify: missing env var ${name}`);
  return value;
};

const WEBHOOK_SECRET = requireEnv('NOTIFY_WEBHOOK_SECRET');

const supabase = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
});

const deps: NotifyDeps = createNotifyPorts(supabase);

function isWellFormed(payload: unknown): payload is NotifyWebhookPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const record = (payload as { record?: unknown }).record;
  if (typeof record !== 'object' || record === null) return false;
  const { event_type, bill_id, recipient_user_id } = record as Record<string, unknown>;
  return typeof event_type === 'string' && typeof bill_id === 'string' && typeof recipient_user_id === 'string';
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  // Checked before anything else touches the request: a missing/mismatched secret means this
  // isn't a real call from the database webhook, so there's nothing further worth doing with it.
  if (req.headers.get('x-notify-secret') !== WEBHOOK_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return new Response('invalid JSON body', { status: 400 });
  }

  if (!isWellFormed(payload)) {
    return new Response('invalid webhook payload', { status: 400 });
  }

  // handleNotifyWebhook never throws (a failed send is logged and dropped, SPEC 8.7 task brief),
  // so this always returns 200 once the payload shape itself checks out.
  await handleNotifyWebhook(payload, deps);
  return new Response('ok', { status: 200 });
});

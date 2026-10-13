/**
 * The data-layer half of `notify`'s dependencies (SPEC 8.7): reading `push_tokens` and sending to
 * the Expo Push API, over the already-created service-role Supabase client from index.ts. No
 * Expo API key is required (https://docs.expo.dev/push-notifications/sending-notifications/).
 *
 * Untested under jest, same as parse-receipt/ports.ts: both are Deno-imported, and the real work
 * here (a live DB round trip, a real HTTP call to Expo) isn't something jest can exercise - the
 * testable decisions (which tokens get a message, what it says) live in src/lib/notify/handler.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExpoPushMessage, NotifyDeps } from '../../../src/lib/notify/handler.ts';

const EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push/send';

export function createNotifyPorts(supabase: SupabaseClient): NotifyDeps {
  return {
    fetchPushTokens: async (userId) => {
      const { data, error } = await supabase.from('push_tokens').select('token').eq('user_id', userId);
      if (error) throw error;
      return (data ?? []).map((row) => row.token as string);
    },

    sendExpoPush: async (messages: ExpoPushMessage[]) => {
      const res = await fetch(EXPO_PUSH_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'accept-encoding': 'gzip, deflate',
        },
        body: JSON.stringify(messages),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Expo push API responded ${res.status}: ${text}`);
      }
    },
  };
}

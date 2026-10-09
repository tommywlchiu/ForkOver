/**
 * The data-layer half of parse-receipt's dependencies (SPEC 8.1/8.4): consent,
 * limits, draft bills, and photo storage, over the already-created
 * service-role Supabase client from index.ts. Every table here (bills,
 * scan_usage, scan_log) and the receipts bucket have RLS enabled with no
 * policies (M3's migrations), so only this service-role client, which
 * bypasses RLS, can reach them.
 *
 * Every signed-in user is treated as free-tier (no `entitlements` table yet;
 * that's M6), so `checkLimits` always applies the monthly quota.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ParseReceiptDeps } from '../../../src/lib/receipt/handler.ts';

/** SPEC 13 default 5. */
const FREE_SCANS_PER_MONTH = 3;
/** SPEC 13 default 6, every tier. */
const RATE_LIMIT_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

// SPEC 8.4: the bucket path is always "<bill_id>/receipt.jpg", regardless of the uploaded
// photo's actual media type (the client always JPEG-compresses before sending, SPEC 7.6).
const RECEIPT_PATH = (billId: string) => `${billId}/receipt.jpg`;

function currentUtcPeriod(now: Date): string {
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${now.getUTCFullYear()}-${month}`;
}

export function createDataPorts(
  supabase: SupabaseClient,
): Pick<
  ParseReceiptDeps,
  'hasAiConsent' | 'checkLimits' | 'createDraftBill' | 'storeReceiptImage' | 'discardDraftBill' | 'recordSuccessfulScan'
> {
  return {
    hasAiConsent: async (userId) => {
      const { data, error } = await supabase.from('profiles').select('ai_consent_at').eq('id', userId).maybeSingle();
      if (error) throw error;
      return data?.ai_consent_at != null;
    },

    checkLimits: async (userId) => {
      const now = new Date();
      // Records this attempt against the hourly limit before counting, so the count below
      // always includes it (SPEC 8.1 scan_log; the JSDoc on ParseReceiptDeps.checkLimits).
      const { error: logError } = await supabase.from('scan_log').insert({ user_id: userId });
      if (logError) throw logError;

      const hourAgo = new Date(now.getTime() - HOUR_MS).toISOString();
      const { count, error: countError } = await supabase
        .from('scan_log')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', hourAgo);
      if (countError) throw countError;
      if ((count ?? 0) > RATE_LIMIT_PER_HOUR) return 'RATE_LIMITED';

      const period = currentUtcPeriod(now);
      const { data: usage, error: usageError } = await supabase
        .from('scan_usage')
        .select('count')
        .eq('user_id', userId)
        .eq('period', period)
        .maybeSingle();
      if (usageError) throw usageError;
      if ((usage?.count ?? 0) >= FREE_SCANS_PER_MONTH) return 'QUOTA_EXCEEDED';

      return 'ok';
    },

    createDraftBill: async (userId) => {
      const { data, error } = await supabase.from('bills').insert({ payer_user_id: userId }).select('id').single();
      if (error) throw error;
      return data.id as string;
    },

    storeReceiptImage: async (billId, image, mediaType) => {
      const path = RECEIPT_PATH(billId);
      const { error: uploadError } = await supabase.storage
        .from('receipts')
        .upload(path, image, { contentType: mediaType, upsert: true });
      if (uploadError) throw uploadError;
      const { error: updateError } = await supabase.from('bills').update({ receipt_path: path }).eq('id', billId);
      if (updateError) throw updateError;
    },

    discardDraftBill: async (billId) => {
      // Best effort (handler.ts wraps this call in .catch): the photo may never have been
      // uploaded, so a missing-object error here is not a failure worth surfacing.
      await supabase.storage.from('receipts').remove([RECEIPT_PATH(billId)]);
      const { error } = await supabase.from('bills').delete().eq('id', billId);
      if (error) throw error;
    },

    recordSuccessfulScan: async (userId) => {
      const period = currentUtcPeriod(new Date());
      const { error } = await supabase.rpc('increment_scan_usage', { p_user_id: userId, p_period: period });
      if (error) throw error;
    },
  };
}

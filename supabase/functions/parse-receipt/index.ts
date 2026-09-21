/**
 * parse-receipt Edge Function (SPEC.md section 7). Thin wiring only: the logic
 * is in src/lib/receipt so it is unit tested under jest.
 *
 * Secrets (set with `supabase secrets set`, or supabase/functions/.env.local
 * for `supabase functions serve --env-file`): ANTHROPIC_API_KEY, ANTHROPIC_MODEL.
 * Optional: MAX_IMAGE_BYTES (default 5000000). SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
 */
import { createClient } from '@supabase/supabase-js';
import { handleParseReceipt, type ParseReceiptDeps } from '../../../src/lib/receipt/handler.ts';
import { dataPorts } from './ports.ts';

const DEFAULT_MAX_IMAGE_BYTES = 5_000_000;

const requireEnv = (name: string): string => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`parse-receipt: missing env var ${name}`);
  return value;
};

const supabase = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
});

const deps: ParseReceiptDeps = {
  ...dataPorts,
  authenticate: async (req) => {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return null;
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return null;
    return { userId: data.user.id, isAnonymous: data.user.is_anonymous ?? false };
  },
  anthropic: { apiKey: requireEnv('ANTHROPIC_API_KEY'), model: requireEnv('ANTHROPIC_MODEL') },
  maxImageBytes: Number(Deno.env.get('MAX_IMAGE_BYTES') ?? DEFAULT_MAX_IMAGE_BYTES),
};

Deno.serve((req) => handleParseReceipt(req, deps));

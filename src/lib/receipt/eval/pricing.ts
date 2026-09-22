/**
 * ==========================================================================
 * PRICES USED FOR THE EVAL'S COST FIGURES. UPDATE THIS FILE, AND ONLY THIS
 * FILE, WHEN ANTHROPIC CHANGES ITS PRICES OR YOU EVAL ANOTHER MODEL.
 *
 * Source:    https://platform.claude.com/docs/en/about-claude/pricing
 * Taken on:  2026-09-21 (standard API rates, USD per million tokens)
 *
 * Only base input and output tokens are priced. Prompt caching, the batch
 * discount, and `inference_geo: "us"` (1.1x) are not applied: the parser sends
 * none of them. Cost figures in the report are only as current as this file.
 * ==========================================================================
 */

export const PRICING_SOURCE_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
export const PRICING_TAKEN_ON = '2026-09-21';

export type ModelPrice = { inputUsdPerMTok: number; outputUsdPerMTok: number };

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-haiku-4-5-20251001': { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
  'claude-sonnet-5': { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
};

export const COST_DISCLAIMER =
  `Cost figures use the per-million-token prices in src/lib/receipt/eval/pricing.ts, taken from ` +
  `${PRICING_SOURCE_URL} on ${PRICING_TAKEN_ON}. They are only as current as that file.`;

/**
 * Local analytics timing events. See SPEC.md section 8.8. This is the
 * interface a future first-party `analytics_events` table would implement;
 * for now it just keeps an in-memory, per-install log, with no third-party
 * SDK and no receipt contents, item names, or amounts.
 */

export type AnalyticsEventName =
  | 'scan_shutter'
  | 'parse_first_item'
  | 'parse_done'
  | 'review_confirmed'
  | 'bill_sent'
  | 'claim_page_opened'
  | 'first_claim'
  | 'bill_closed'
  | 'paywall_shown'
  | 'upgrade_completed'
  | 'drop_off';

/** Allowlisted props only (SPEC 8.8): durations, screen names, platform, item counts. */
export type AnalyticsProps = {
  durationMs?: number;
  screen?: string;
  platform?: string;
  itemCount?: number;
};

export type AnalyticsEvent = {
  name: AnalyticsEventName;
  props: AnalyticsProps;
  installId: string;
  at: number;
};

export type AnalyticsSink = {
  record: (name: AnalyticsEventName, props?: AnalyticsProps) => AnalyticsEvent;
  events: () => readonly AnalyticsEvent[];
  clear: () => void;
};

function randomInstallId(): string {
  return `install-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** An insert-only, in-memory analytics log for one install. */
export function createLocalAnalytics(installId: string = randomInstallId()): AnalyticsSink {
  const log: AnalyticsEvent[] = [];
  return {
    record(name, props = {}) {
      const event: AnalyticsEvent = { name, props, installId, at: Date.now() };
      log.push(event);
      return event;
    },
    events: () => log,
    clear: () => {
      log.length = 0;
    },
  };
}

/**
 * The headline metric (PRD Success metrics): median of `bill_sent` minus
 * `scan_shutter`, pairing each shutter with the next sent event after it.
 */
export function medianShutterToSentMs(events: readonly AnalyticsEvent[]): number | null {
  const shutters = events.filter((e) => e.name === 'scan_shutter').map((e) => e.at);
  const sents = events.filter((e) => e.name === 'bill_sent').map((e) => e.at);
  const deltas: number[] = [];
  let sentIndex = 0;
  for (const shutterAt of shutters) {
    while (sentIndex < sents.length && sents[sentIndex] < shutterAt) sentIndex++;
    if (sentIndex >= sents.length) break;
    deltas.push(sents[sentIndex] - shutterAt);
    sentIndex++;
  }
  if (deltas.length === 0) return null;
  const sorted = [...deltas].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

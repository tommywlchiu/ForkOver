import { createLocalAnalytics, medianShutterToSentMs } from './analytics';

describe('createLocalAnalytics', () => {
  it('records events with the install id and a timestamp', () => {
    const analytics = createLocalAnalytics('install-1');
    const event = analytics.record('scan_shutter');
    expect(event.name).toBe('scan_shutter');
    expect(event.installId).toBe('install-1');
    expect(typeof event.at).toBe('number');
    expect(analytics.events()).toEqual([event]);
  });

  it('keeps only allowlisted props', () => {
    const analytics = createLocalAnalytics('install-1');
    analytics.record('parse_done', { itemCount: 5, durationMs: 1200 });
    expect(analytics.events()[0].props).toEqual({ itemCount: 5, durationMs: 1200 });
  });

  it('clears the log', () => {
    const analytics = createLocalAnalytics('install-1');
    analytics.record('bill_sent');
    analytics.clear();
    expect(analytics.events()).toEqual([]);
  });

  it('defaults to a random install id when none is given', () => {
    const a = createLocalAnalytics();
    const b = createLocalAnalytics();
    expect(a.record('scan_shutter').installId).not.toBe(b.record('scan_shutter').installId);
  });
});

describe('medianShutterToSentMs', () => {
  it('returns null with no shutter/sent pairs', () => {
    expect(medianShutterToSentMs([])).toBeNull();
  });

  it('pairs each shutter with the next sent event and returns the median delta', () => {
    const events = [
      { name: 'scan_shutter', props: {}, installId: 'i', at: 0 },
      { name: 'bill_sent', props: {}, installId: 'i', at: 1000 },
      { name: 'scan_shutter', props: {}, installId: 'i', at: 5000 },
      { name: 'bill_sent', props: {}, installId: 'i', at: 8000 },
      { name: 'scan_shutter', props: {}, installId: 'i', at: 9000 },
      { name: 'bill_sent', props: {}, installId: 'i', at: 9500 },
    ] as const;
    // Deltas: 1000, 3000, 500 -> median 1000.
    expect(medianShutterToSentMs([...events])).toBe(1000);
  });

  it('ignores a trailing shutter with no matching sent event', () => {
    const events = [
      { name: 'scan_shutter', props: {}, installId: 'i', at: 0 },
      { name: 'bill_sent', props: {}, installId: 'i', at: 1000 },
      { name: 'scan_shutter', props: {}, installId: 'i', at: 5000 },
    ] as const;
    expect(medianShutterToSentMs([...events])).toBe(1000);
  });
});

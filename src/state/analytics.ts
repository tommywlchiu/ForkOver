/**
 * The app-wide analytics sink (SPEC.md section 8.8). A single in-memory log
 * for this install; screens call `analytics.record(...)` directly since
 * there's nothing to render reactively from it yet.
 */
import { createLocalAnalytics } from '../lib/analytics/analytics';

export const analytics = createLocalAnalytics();

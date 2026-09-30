import { Slot } from 'expo-router';

/**
 * Root layout: the (auth) and (app) group layouts each own their own Stack
 * and auth guard (SPEC.md section 2.1), so this just needs to render
 * whichever group matched the URL.
 */
export default function RootLayout() {
  return <Slot />;
}

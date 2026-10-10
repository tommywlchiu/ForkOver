import { useEffect, useRef } from 'react';
import { Redirect, Stack } from 'expo-router';
import { useSessionStore } from '../../state/session';
import { registerForPushNotifications } from '../../data/pushTokens';

/** Nothing here is reachable before sign-in and a username (SPEC 2.1). */
export default function AppLayout() {
  const isSignedIn = useSessionStore((s) => s.isSignedIn);
  const username = useSessionStore((s) => s.username);
  const userId = useSessionStore((s) => s.userId);

  // Registers this device's push token once per sign-in (SPEC 8.7), not on every re-render. The
  // ref is only set on confirmed success, so a transient failure (network blip, a denied
  // permission prompt) doesn't permanently block retrying for this sign-in - it just waits for
  // the next render where `userId`/`username` are (still) set.
  const registeredUserId = useRef<string | null>(null);
  useEffect(() => {
    if (!userId || !username || registeredUserId.current === userId) return;
    let cancelled = false;
    registerForPushNotifications(userId).then((ok) => {
      if (!cancelled && ok) registeredUserId.current = userId;
    });
    return () => {
      cancelled = true;
    };
  }, [userId, username]);

  if (!isSignedIn) return <Redirect href="/sign-in" />;
  if (!username) return <Redirect href="/username" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}

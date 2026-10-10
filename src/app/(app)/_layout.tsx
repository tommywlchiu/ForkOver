import { useEffect, useRef } from 'react';
import { Redirect, Stack } from 'expo-router';
import { useSessionStore } from '../../state/session';
import { registerForPushNotifications } from '../../data/pushTokens';

/** Nothing here is reachable before sign-in and a username (SPEC 2.1). */
export default function AppLayout() {
  const isSignedIn = useSessionStore((s) => s.isSignedIn);
  const username = useSessionStore((s) => s.username);
  const userId = useSessionStore((s) => s.userId);

  // Registers this device's push token once per sign-in (SPEC 8.7), not on every re-render.
  const registeredUserId = useRef<string | null>(null);
  useEffect(() => {
    if (!userId || !username || registeredUserId.current === userId) return;
    registeredUserId.current = userId;
    registerForPushNotifications(userId);
  }, [userId, username]);

  if (!isSignedIn) return <Redirect href="/sign-in" />;
  if (!username) return <Redirect href="/username" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}

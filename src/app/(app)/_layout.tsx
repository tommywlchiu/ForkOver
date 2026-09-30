import { Redirect, Stack } from 'expo-router';
import { useSessionStore } from '../../state/session';

/** Nothing here is reachable before sign-in and a username (SPEC 2.1). */
export default function AppLayout() {
  const isSignedIn = useSessionStore((s) => s.isSignedIn);
  const username = useSessionStore((s) => s.username);

  if (!isSignedIn) return <Redirect href="/sign-in" />;
  if (!username) return <Redirect href="/username" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}

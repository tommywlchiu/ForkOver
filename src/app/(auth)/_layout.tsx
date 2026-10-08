import { Redirect, Stack } from 'expo-router';
import { useSessionStore } from '../../state/session';

/**
 * Nothing else in the app is reachable before sign-in and username (SPEC 2.1).
 * Once both are done, hitting a sign-in route bounces back to Home.
 */
export default function AuthLayout() {
  const isSignedIn = useSessionStore((s) => s.isSignedIn);
  const username = useSessionStore((s) => s.username);

  if (isSignedIn && username) return <Redirect href="/" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}

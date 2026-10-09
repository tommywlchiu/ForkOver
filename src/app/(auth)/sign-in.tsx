/**
 * Sign-in (SPEC.md section 2.1, FR-20): real Google sign-in through Supabase Auth
 * (SPEC.md section 11, M3 part 1). Sign in with Apple is deferred to M6, when the $99/yr Apple
 * Developer account is needed regardless for store submission.
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SecondaryButton } from '../../components/Buttons';
import { useThemeTokens } from '../../components/useThemeTokens';
import { useSessionStore } from '../../state/session';

export default function SignIn() {
  const theme = useThemeTokens();
  const signIn = useSessionStore((s) => s.signIn);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const continueWithGoogle = async () => {
    setError(null);
    setIsSigningIn(true);
    try {
      await signIn('google');
      router.replace('/username');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed. Please try again.');
    } finally {
      setIsSigningIn(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <Text style={[styles.title, { color: theme.text }]}>ForkOver</Text>
      <Text style={[styles.subtitle, { color: theme.textMuted }]}>
        Scan the receipt, split it instantly, every share to the cent.
      </Text>

      {error && (
        <Text testID="sign-in-error" accessibilityRole="alert" style={{ color: theme.danger, textAlign: 'center' }}>
          {error}
        </Text>
      )}

      <View style={styles.buttons}>
        <SecondaryButton
          testID="sign-in-google-button"
          label={isSigningIn ? 'Signing in…' : 'Sign in with Google'}
          onPress={continueWithGoogle}
          disabled={isSigningIn}
        />
        {isSigningIn && <ActivityIndicator testID="sign-in-spinner" />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 16 },
  title: { fontSize: 34, fontWeight: '800', textAlign: 'center' },
  subtitle: { fontSize: 16, textAlign: 'center', marginBottom: 8 },
  buttons: { gap: 12, marginTop: 24 },
});

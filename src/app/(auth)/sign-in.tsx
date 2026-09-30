/**
 * STAND-IN sign-in (SPEC.md section 2.1, FR-20). Real Sign in with Apple and
 * Google, exchanged with Supabase Auth, are out of scope for this part
 * (SPEC.md section 11, M3); both buttons just create a local stub session.
 */
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { PrimaryButton, SecondaryButton } from '../../components/Buttons';
import { useThemeTokens } from '../../components/useThemeTokens';
import { useSessionStore } from '../../state/session';

export default function SignIn() {
  const theme = useThemeTokens();
  const signIn = useSessionStore((s) => s.signIn);

  const continueAs = (provider: 'apple' | 'google') => {
    signIn(provider);
    router.replace('/username');
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <Text style={[styles.title, { color: theme.text }]}>ForkOver</Text>
      <Text style={[styles.subtitle, { color: theme.textMuted }]}>
        Scan the receipt, split it instantly, every share to the cent.
      </Text>

      <View
        testID="stand-in-notice"
        accessibilityRole="text"
        style={[styles.notice, { backgroundColor: theme.warningSurface }]}
      >
        <Text style={{ color: theme.onWarningSurface }}>
          Stand-in sign-in for this build — no real account is created yet.
        </Text>
      </View>

      <View style={styles.buttons}>
        <PrimaryButton testID="sign-in-apple-button" label="Sign in with Apple" onPress={() => continueAs('apple')} />
        <SecondaryButton
          testID="sign-in-google-button"
          label="Sign in with Google"
          onPress={() => continueAs('google')}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 16 },
  title: { fontSize: 34, fontWeight: '800', textAlign: 'center' },
  subtitle: { fontSize: 16, textAlign: 'center', marginBottom: 8 },
  notice: { borderRadius: 12, padding: 12 },
  buttons: { gap: 12, marginTop: 24 },
});

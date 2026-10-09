/**
 * Username step (SPEC.md sections 2.1, 13 default 16): 3-20 chars, lowercase
 * letters/digits/underscores, unique regardless of case. This only validates the shape and
 * writes to the signed-in user's `profiles` row; live uniqueness checking as you type is M4
 * (`search_usernames`). A unique-constraint violation on submit (SPEC 8.1) surfaces as a plain
 * "taken" message instead.
 */
import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { PrimaryButton } from '../../components/Buttons';
import { useThemeTokens } from '../../components/useThemeTokens';
import { useSessionStore } from '../../state/session';

const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;

export default function Username() {
  const theme = useThemeTokens();
  const isSignedIn = useSessionStore((s) => s.isSignedIn);
  const setUsername = useSessionStore((s) => s.setUsername);
  const [username, setUsernameText] = useState('');
  const [venmo, setVenmo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isSignedIn) return <Redirect href="/sign-in" />;

  const submit = async () => {
    const normalized = username.trim().toLowerCase();
    if (!USERNAME_PATTERN.test(normalized)) {
      setError('3 to 20 characters: lowercase letters, digits, and underscores.');
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await setUsername(normalized, venmo);
      if (!result.ok) {
        setError(
          result.reason === 'taken'
            ? "That username's taken, try another."
            : 'Something went wrong saving your username. Please try again.',
        );
        return;
      }
      router.replace('/');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <Text style={[styles.title, { color: theme.text }]}>Pick a username</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        Friends find you by this username to send you bills.
      </Text>
      <TextInput
        testID="username-input"
        value={username}
        onChangeText={(text) => {
          setUsernameText(text);
          setError(null);
        }}
        placeholder="username"
        placeholderTextColor={theme.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Username"
        style={[styles.input, { borderColor: theme.border, color: theme.text, backgroundColor: theme.surface }]}
      />
      {error && (
        <Text testID="username-error" style={{ color: theme.danger }}>
          {error}
        </Text>
      )}

      <Text style={[styles.hint, { color: theme.textMuted, marginTop: 20 }]}>
        Optional: your Venmo username, so friends can pay you back on Venmo (FR-19).
      </Text>
      <TextInput
        testID="venmo-username-input"
        value={venmo}
        onChangeText={setVenmo}
        placeholder="venmo-username (optional)"
        placeholderTextColor={theme.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Venmo username, optional"
        style={[styles.input, { borderColor: theme.border, color: theme.text, backgroundColor: theme.surface }]}
      />

      <PrimaryButton
        testID="username-continue-button"
        label={isSubmitting ? 'Saving…' : 'Continue'}
        onPress={submit}
        disabled={username.trim().length === 0 || isSubmitting}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 28, fontWeight: '800' },
  hint: { fontSize: 14 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
});

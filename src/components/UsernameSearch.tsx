/**
 * "Find a friend by username" search (SPEC.md section 8.2). Calls the already-merged
 * `search_usernames` RPC, which requires a signed-in caller, trims/ignores prefixes under 2
 * characters, and returns at most 10 rows. Debounced so it doesn't call on every keystroke.
 *
 * Wired into the share screen's "Send in app" invite flow (M4 in-app-sending task): `onSelect`
 * calls `invite_bill_member` with the chosen result. `excludeUserId` (typically the signed-in
 * caller's own id) filters that user out of the results client-side - `search_usernames` itself
 * doesn't know what this search is for, so it has no reason to exclude anyone - cheaper than
 * letting the caller tap themselves and get a guaranteed-to-repeat "cannot invite yourself" error
 * back from whatever RPC actually acts on the selection.
 */
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { supabase } from '../data/supabaseClient';
import { useThemeTokens } from './useThemeTokens';

const MIN_PREFIX_LENGTH = 2;
const DEBOUNCE_MS = 300;

export type UsernameSearchResult = {
  id: string;
  username: string;
  display_name: string | null;
};

type SearchState = 'idle' | 'loading' | 'results' | 'empty' | 'error';

export function UsernameSearch({
  onSelect,
  excludeUserId,
}: {
  onSelect: (user: UsernameSearchResult) => void;
  /** Filters this user id out of the results (e.g. the signed-in caller, who can't invite themselves). */
  excludeUserId?: string;
}) {
  const theme = useThemeTokens();
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>('idle');
  const [results, setResults] = useState<UsernameSearchResult[]>([]);
  // Guards against a slower, earlier request overwriting a faster, later one.
  const requestId = useRef(0);

  // Reacts to the user's own keystroke, not an effect synchronizing with an external system, so
  // the "too short"/"loading" transition happens here rather than as a setState inside an effect.
  const handleChangeText = (text: string) => {
    setQuery(text);
    requestId.current += 1;
    if (text.trim().length < MIN_PREFIX_LENGTH) {
      setResults([]);
      setState('idle');
    } else {
      setState('loading');
    }
  };

  useEffect(() => {
    const prefix = query.trim();
    if (prefix.length < MIN_PREFIX_LENGTH) return;

    const thisRequest = requestId.current;
    const handle = setTimeout(async () => {
      const { data, error } = await supabase.rpc('search_usernames', { p_prefix: prefix });
      if (requestId.current !== thisRequest) return; // superseded by a newer keystroke
      if (error) {
        setResults([]);
        setState('error');
        return;
      }
      const rows = ((data ?? []) as UsernameSearchResult[]).filter((row) => row.id !== excludeUserId);
      setResults(rows);
      setState(rows.length > 0 ? 'results' : 'empty');
    }, DEBOUNCE_MS);

    return () => clearTimeout(handle);
  }, [query, excludeUserId]);

  return (
    <View>
      <TextInput
        testID="username-search-input"
        value={query}
        onChangeText={handleChangeText}
        placeholder="Search by username"
        placeholderTextColor={theme.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Search by username"
        style={[styles.input, { borderColor: theme.border, color: theme.text, backgroundColor: theme.surface }]}
      />

      {state === 'loading' && (
        <ActivityIndicator testID="username-search-loading" color={theme.primary} style={styles.status} />
      )}

      {state === 'empty' && (
        <Text testID="username-search-empty" style={[styles.status, { color: theme.textMuted }]}>
          No one found.
        </Text>
      )}

      {state === 'error' && (
        <Text testID="username-search-error" style={[styles.status, { color: theme.danger }]}>
          Something went wrong searching. Please try again.
        </Text>
      )}

      {state === 'results' &&
        results.map((user) => (
          <Pressable
            key={user.id}
            testID={`username-search-result-${user.id}`}
            onPress={() => onSelect(user)}
            accessibilityRole="button"
            accessibilityLabel={user.display_name ? `${user.display_name}, @${user.username}` : `@${user.username}`}
            style={({ pressed }) => [
              styles.row,
              { borderColor: theme.border, backgroundColor: pressed ? theme.surfaceAlt : theme.surface },
            ]}
          >
            <Text style={[styles.username, { color: theme.text }]}>@{user.username}</Text>
            {user.display_name && (
              <Text style={[styles.displayName, { color: theme.textMuted }]}>{user.display_name}</Text>
            )}
          </Pressable>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  status: { marginTop: 10 },
  row: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginTop: 8,
    justifyContent: 'center',
  },
  username: { fontSize: 16, fontWeight: '700' },
  displayName: { fontSize: 14 },
});

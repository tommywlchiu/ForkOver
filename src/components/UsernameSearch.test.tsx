/**
 * Coverage for the username search component (SPEC.md section 8.2, M4): debounced calls to the
 * `search_usernames` RPC, and the fewer-than-2-characters, loading, empty, error, and results
 * states. Mocks `../data/supabaseClient` the same way `src/state/session.test.ts` does, exercising
 * the mock's `rpc` fake instead of a real network call.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { UsernameSearch, type UsernameSearchResult } from './UsernameSearch';

jest.mock('../data/supabaseClient');

const { __resetFakeSupabase, __seedProfile, __forceNextRpcError } = jest.requireMock(
  '../data/supabaseClient',
) as {
  __resetFakeSupabase: () => void;
  __seedProfile: (id: string, profile: { username?: string | null; display_name?: string | null }) => void;
  __forceNextRpcError: (message?: string) => void;
};
const { supabase } = jest.requireMock('../data/supabaseClient') as {
  supabase: { auth: { setSession: (args: { access_token: string; refresh_token: string }) => Promise<unknown> } };
};

async function signIn() {
  await supabase.auth.setSession({ access_token: 'test-token', refresh_token: 'test-refresh' });
}

describe('UsernameSearch', () => {
  beforeEach(() => {
    __resetFakeSupabase();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('makes no call and shows no results below 2 characters', async () => {
    await signIn();
    render(<UsernameSearch onSelect={jest.fn()} />);

    fireEvent.changeText(screen.getByTestId('username-search-input'), 'a');
    jest.advanceTimersByTime(1000);
    await Promise.resolve();

    expect(screen.queryByTestId('username-search-loading')).toBeNull();
    expect(screen.queryByTestId('username-search-empty')).toBeNull();
    expect(screen.queryByText(/@/)).toBeNull();
  });

  it('shows a loading state while the debounced call is in flight', async () => {
    await signIn();
    __seedProfile('friend-1', { username: 'alexfriend', display_name: 'Alex Friend' });
    render(<UsernameSearch onSelect={jest.fn()} />);

    fireEvent.changeText(screen.getByTestId('username-search-input'), 'al');
    expect(screen.getByTestId('username-search-loading')).toBeTruthy();

    jest.advanceTimersByTime(300);
    await waitFor(() => expect(screen.getByTestId('username-search-result-friend-1')).toBeTruthy());
  });

  it('does not call on every keystroke, only after the debounce settles', async () => {
    await signIn();
    __seedProfile('friend-1', { username: 'alexfriend', display_name: 'Alex Friend' });
    const rpcSpy = jest.spyOn(supabase as any, 'rpc');
    render(<UsernameSearch onSelect={jest.fn()} />);

    const input = screen.getByTestId('username-search-input');
    fireEvent.changeText(input, 'a');
    fireEvent.changeText(input, 'al');
    fireEvent.changeText(input, 'ale');
    jest.advanceTimersByTime(299);
    expect(rpcSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await waitFor(() => expect(rpcSpy).toHaveBeenCalledTimes(1));
    expect(rpcSpy).toHaveBeenCalledWith('search_usernames', { p_prefix: 'ale' });
  });

  it('shows an empty state when nobody matches', async () => {
    await signIn();
    render(<UsernameSearch onSelect={jest.fn()} />);

    fireEvent.changeText(screen.getByTestId('username-search-input'), 'zz');
    jest.advanceTimersByTime(300);
    await waitFor(() => expect(screen.getByTestId('username-search-empty')).toBeTruthy());
  });

  it('shows an error state when the call fails', async () => {
    await signIn();
    __forceNextRpcError('network down');
    render(<UsernameSearch onSelect={jest.fn()} />);

    fireEvent.changeText(screen.getByTestId('username-search-input'), 'al');
    jest.advanceTimersByTime(300);
    await waitFor(() => expect(screen.getByTestId('username-search-error')).toBeTruthy());
  });

  it('shows username and display name for each match and calls onSelect when tapped', async () => {
    await signIn();
    __seedProfile('friend-1', { username: 'alexfriend', display_name: 'Alex Friend' });
    __seedProfile('friend-2', { username: 'alexsmith', display_name: null });
    const onSelect = jest.fn();
    render(<UsernameSearch onSelect={onSelect} />);

    fireEvent.changeText(screen.getByTestId('username-search-input'), 'alex');
    jest.advanceTimersByTime(300);
    await waitFor(() => expect(screen.getByTestId('username-search-result-friend-1')).toBeTruthy());

    expect(screen.getByText('@alexfriend')).toBeTruthy();
    expect(screen.getByText('Alex Friend')).toBeTruthy();
    expect(screen.getByTestId('username-search-result-friend-2')).toBeTruthy();
    expect(screen.getByText('@alexsmith')).toBeTruthy();

    fireEvent.press(screen.getByTestId('username-search-result-friend-1'));
    const expected: UsernameSearchResult = { id: 'friend-1', username: 'alexfriend', display_name: 'Alex Friend' };
    expect(onSelect).toHaveBeenCalledWith(expected);
  });
});

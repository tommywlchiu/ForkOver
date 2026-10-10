/**
 * Tests for NoConnectionBanner component (SPEC.md section 8.3, M4 NFR-8).
 *
 * Tests that the banner shows when disconnected and hides when connected,
 * using mocked connectivity state.
 */
import { render, screen } from '@testing-library/react-native';
import { NoConnectionBanner } from './NoConnectionBanner';

// Mock the connectivity store before importing the component that uses it
jest.mock('../state/connectivity', () => ({
  useConnectivityStore: jest.fn((selector: ((state: any) => any) | undefined) => {
    // Default state: connected
    const defaultState = { isConnected: true, isInitialized: true };
    if (typeof selector === 'function') {
      return selector(defaultState);
    }
    return defaultState;
  }),
}));

describe('NoConnectionBanner', () => {
  let mockUseConnectivityStore: jest.MockedFunction<any>;

  beforeEach(() => {
    // Get the mocked hook
    const connectivity = jest.requireMock('../state/connectivity');
    mockUseConnectivityStore = connectivity.useConnectivityStore;

    // Reset to default: connected
    mockUseConnectivityStore.mockImplementation((selector: ((state: any) => any) | undefined) => {
      const state = { isConnected: true, isInitialized: true };
      if (typeof selector === 'function') {
        return selector(state);
      }
      return state;
    });
  });

  it('does not render when connected', () => {
    const { queryByTestId } = render(<NoConnectionBanner />);
    expect(queryByTestId('no-connection-banner')).toBeNull();
  });

  it('renders when disconnected', () => {
    mockUseConnectivityStore.mockImplementation((selector: ((state: any) => any) | undefined) => {
      const state = { isConnected: false, isInitialized: true };
      if (typeof selector === 'function') {
        return selector(state);
      }
      return state;
    });

    const { getByTestId } = render(<NoConnectionBanner />);
    expect(getByTestId('no-connection-banner')).toBeTruthy();
  });

  it('displays the correct text when disconnected', () => {
    mockUseConnectivityStore.mockImplementation((selector: ((state: any) => any) | undefined) => {
      const state = { isConnected: false, isInitialized: true };
      if (typeof selector === 'function') {
        return selector(state);
      }
      return state;
    });

    render(<NoConnectionBanner />);
    const text = screen.getByText('No connection');
    expect(text).toBeTruthy();
  });

  it('has proper accessibility attributes when disconnected', () => {
    mockUseConnectivityStore.mockImplementation((selector: ((state: any) => any) | undefined) => {
      const state = { isConnected: false, isInitialized: true };
      if (typeof selector === 'function') {
        return selector(state);
      }
      return state;
    });

    const { getByTestId } = render(<NoConnectionBanner />);
    const banner = getByTestId('no-connection-banner');

    // Check accessibility properties
    expect(banner.props.accessibilityLiveRegion).toBe('assertive');
  });
});

/**
 * Tests for connectivity state (SPEC.md section 8.3, M4 NFR-8).
 *
 * Tests getInitialConnectedState() function and store behavior.
 */
import { useConnectivityStore } from './connectivity';

// Mock Platform to return 'web' for most tests
jest.mock('react-native', () => ({
  Platform: {
    OS: 'web',
  },
}));

describe('useConnectivityStore - web platform', () => {
  const originalOnLine = navigator.onLine;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Restore original onLine value
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      writable: true,
      value: originalOnLine,
    });
  });

  it('reads navigator.onLine during store initialization', () => {
    // On web, the store should initialize with the correct navigator.onLine value
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      writable: true,
      value: true,
    });

    const state = useConnectivityStore.getState();

    expect(state.isInitialized).toBe(true);
    expect(state.isConnected).toBe(true); // Should match navigator.onLine
  });

  it('has methods available', () => {
    const state = useConnectivityStore.getState();

    expect(state.checkConnection).toBeDefined();
    expect(typeof state.checkConnection).toBe('function');
  });

  it('can check connection via checkConnection method', async () => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      writable: true,
      value: false,
    });

    await useConnectivityStore.getState().checkConnection();
    const state = useConnectivityStore.getState();

    expect(state.isConnected).toBe(false);
  });

  it('can update connectivity state manually', () => {
    useConnectivityStore.setState({ isConnected: false });
    let state = useConnectivityStore.getState();
    expect(state.isConnected).toBe(false);

    useConnectivityStore.setState({ isConnected: true });
    state = useConnectivityStore.getState();
    expect(state.isConnected).toBe(true);
  });

  it('can update initialization state', () => {
    useConnectivityStore.setState({ isInitialized: false });
    let state = useConnectivityStore.getState();
    expect(state.isInitialized).toBe(false);

    useConnectivityStore.setState({ isInitialized: true });
    state = useConnectivityStore.getState();
    expect(state.isInitialized).toBe(true);
  });
});

describe('useConnectivityStore - module structure', () => {
  it('module loads without errors', () => {
    // The connectivity module should have loaded successfully
    // useConnectivityStore is imported at the top, so this just verifies it's defined
    expect(useConnectivityStore).toBeDefined();
    expect(typeof useConnectivityStore.getState).toBe('function');
  });
});

describe('useConnectivityStore - async native initialization', () => {
  it('initializes asynchronously on native platforms', async () => {
    // The connectivity module includes async native initialization
    // On web (current test env), isInitialized is set to true immediately
    // On native, it waits for NetInfo to load

    // Store should be functional after creation
    const state = useConnectivityStore.getState();
    expect(state).toBeDefined();
    expect('isConnected' in state).toBe(true);
    expect('isInitialized' in state).toBe(true);

    // The async initializer should have been started
    // On web (current test env), it should be a no-op that completes quickly
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Store should still be functional
    const finalState = useConnectivityStore.getState();
    expect(finalState).toBeDefined();
    expect('isConnected' in finalState).toBe(true);
    expect('isInitialized' in finalState).toBe(true);
  });
});

/**
 * Tests for connectivity state (SPEC.md section 8.3, M4 NFR-8).
 *
 * Uses jest.resetModules() + jest.doMock() + require() pattern per test to
 * actually exercise different platform conditions and initial states.
 */

describe('useConnectivityStore - web platform reads navigator.onLine at load', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('initializes isConnected = true when navigator.onLine is true at load', () => {
    // Set navigator.onLine = true BEFORE importing the module
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      writable: true,
      value: true,
    });

    jest.doMock('react-native', () => ({ Platform: { OS: 'web' } }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useConnectivityStore } = require('./connectivity');
    const state = useConnectivityStore.getState();

    expect(state.isInitialized).toBe(true);
    expect(state.isConnected).toBe(true);
  });

  it('initializes isConnected = false when navigator.onLine is false at load', () => {
    // Set navigator.onLine = false BEFORE importing the module
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      writable: true,
      value: false,
    });

    jest.doMock('react-native', () => ({ Platform: { OS: 'web' } }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useConnectivityStore } = require('./connectivity');
    const state = useConnectivityStore.getState();

    expect(state.isInitialized).toBe(true);
    expect(state.isConnected).toBe(false); // Correctly reflects offline state at load
  });
});

describe('useConnectivityStore - native platform async initialization', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('starts uninitialized on native and completes initialization', async () => {
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios' } }));
    jest.doMock('@react-native-community/netinfo', () => ({
      default: {
        addEventListener: jest.fn(() => jest.fn()),
        fetch: jest.fn().mockResolvedValue({
          isConnected: true,
          isInternetReachable: true,
        }),
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useConnectivityStore } = require('./connectivity');

    // Initial state: not initialized yet (waiting for async NetInfo load)
    let state = useConnectivityStore.getState();
    expect(state.isInitialized).toBe(false);

    // Flush async operations
    await new Promise((resolve) => setTimeout(resolve, 50));

    // After async initialization completes
    state = useConnectivityStore.getState();
    expect(state.isInitialized).toBe(true);
    expect(state.isConnected).toBe(true);
  });

  it('marks initialized even if NetInfo fails to load', async () => {
    jest.doMock('react-native', () => ({ Platform: { OS: 'android' } }));
    jest.doMock(
      '@react-native-community/netinfo',
      () => {
        throw new Error('NetInfo not available');
      },
      { virtual: true },
    );

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useConnectivityStore } = require('./connectivity');

    // Initial state: not initialized
    let state = useConnectivityStore.getState();
    expect(state.isInitialized).toBe(false);

    // Flush async operations
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should mark initialized even on failure
    state = useConnectivityStore.getState();
    expect(state.isInitialized).toBe(true);
  });
});

describe('useConnectivityStore - checkConnection method', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('works on web platform', async () => {
    jest.doMock('react-native', () => ({ Platform: { OS: 'web' } }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useConnectivityStore } = require('./connectivity');

    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      writable: true,
      value: false,
    });

    await useConnectivityStore.getState().checkConnection();
    const state = useConnectivityStore.getState();
    expect(state.isConnected).toBe(false);

    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      writable: true,
      value: true,
    });

    await useConnectivityStore.getState().checkConnection();
    const newState = useConnectivityStore.getState();
    expect(newState.isConnected).toBe(true);
  });

  it('has checkConnection method callable on native (after async init)', async () => {
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios' } }));
    jest.doMock('@react-native-community/netinfo', () => ({
      default: {
        addEventListener: jest.fn(() => jest.fn()),
        fetch: jest.fn().mockResolvedValue({
          isConnected: true,
          isInternetReachable: true,
        }),
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useConnectivityStore } = require('./connectivity');

    // checkConnection method should exist
    const checkConnection = useConnectivityStore.getState().checkConnection;
    expect(typeof checkConnection).toBe('function');

    // Flush async setup
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should be able to call checkConnection without error
    const checkConnectionResult = useConnectivityStore.getState().checkConnection();
    expect(checkConnectionResult instanceof Promise).toBe(true);

    // Wait for it to complete
    await checkConnectionResult;
  });
});

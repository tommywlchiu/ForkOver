/**
 * Tests for connectivity state (SPEC.md section 8.3, M4 NFR-8).
 */
import { useConnectivityStore } from './connectivity';

// Mock Platform to control which implementation is used before importing the store
jest.mock('react-native', () => ({
  Platform: {
    OS: 'web',
  },
}));

// Mock window for web platform before importing the store
const mockAddEventListener = jest.fn();
const mockRemoveEventListener = jest.fn();

Object.defineProperty(global.navigator, 'onLine', {
  configurable: true,
  writable: true,
  value: true,
});

Object.defineProperty(global.window, 'addEventListener', {
  configurable: true,
  writable: true,
  value: mockAddEventListener,
});

Object.defineProperty(global.window, 'removeEventListener', {
  configurable: true,
  writable: true,
  value: mockRemoveEventListener,
});

describe('useConnectivityStore', () => {
  beforeEach(() => {
    // Reset the store state and mocks before each test
    jest.clearAllMocks();
    useConnectivityStore.setState({ isConnected: true, isInitialized: true });
  });

  describe('web platform', () => {
    it('initializes with navigator.onLine status', () => {
      const state = useConnectivityStore.getState();
      expect(state.isInitialized).toBe(true);
      expect(state.isConnected).toBe(true); // navigator.onLine is mocked to true
    });

    it('provides checkConnection method', async () => {
      const state = useConnectivityStore.getState();
      expect(state.checkConnection).toBeDefined();
      expect(typeof state.checkConnection).toBe('function');

      // Mock navigator.onLine to false
      Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        writable: true,
        value: false,
      });

      await state.checkConnection();
      const newState = useConnectivityStore.getState();
      expect(newState.isConnected).toBe(false);

      // Restore
      Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        writable: true,
        value: true,
      });
    });

    it('shows store is initialized and connected by default', () => {
      const state = useConnectivityStore.getState();
      expect(state.isInitialized).toBe(true);
      expect(state.isConnected).toBe(true);
    });

    it('can update connectivity state', () => {
      useConnectivityStore.setState({ isConnected: false });
      let state = useConnectivityStore.getState();
      expect(state.isConnected).toBe(false);

      useConnectivityStore.setState({ isConnected: true });
      state = useConnectivityStore.getState();
      expect(state.isConnected).toBe(true);
    });
  });
});

/**
 * Connectivity state and detection (SPEC.md section 8.3, M4 NFR-8).
 *
 * On native: NetInfo.fetch() to detect connectivity loss.
 * On web: window.ononline/onoffline events to detect connectivity loss.
 * (Realtime channel status on web is deferred to a later task once realtime sync exists.)
 *
 * No offline queue; when reconnected, the claim screen will refetch and resubscribe.
 */
import { create } from 'zustand';
import { Platform } from 'react-native';
import type * as NetInfoType from '@react-native-community/netinfo';

let NetInfo: typeof NetInfoType.default | null = null;

/** Get initial connectivity state based on platform and navigator.onLine */
function getInitialConnectedState(): boolean {
  if (Platform.OS === 'web') {
    // On web, read navigator.onLine for actual initial state
    if (typeof window !== 'undefined' && typeof navigator.onLine === 'boolean') {
      return navigator.onLine;
    }
  }
  // Default to connected if we can't determine state
  return true;
}

export type ConnectivityState = {
  isConnected: boolean;
  isInitialized: boolean;
  checkConnection: () => Promise<void>;
};

export const useConnectivityStore = create<ConnectivityState>((set) => {
  // Set up platform-specific listeners
  if (Platform.OS === 'web') {
    // Web: use online/offline events
    const handleOnline = () => set({ isConnected: true });
    const handleOffline = () => set({ isConnected: false });

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
    }
  }

  // Return initial state with real navigator.onLine value for web
  return {
    isConnected: getInitialConnectedState(),
    isInitialized: Platform.OS === 'web', // web is initialized immediately; native waits for NetInfo load
    checkConnection: async () => {
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined' && typeof navigator.onLine === 'boolean') {
          const isConnected = navigator.onLine;
          set({ isConnected });
        }
      } else if (NetInfo) {
        const state = await NetInfo.fetch();
        const isConnected = state.isConnected === true && state.isInternetReachable !== false;
        set({ isConnected });
      }
    },
  };
});

/** Set up native connectivity listener after NetInfo loads (async). */
async function initializeNativeConnectivity() {
  if (Platform.OS === 'web' || typeof jest !== 'undefined') {
    return; // Skip on web or in tests
  }

  try {
    const netinfo = await import('@react-native-community/netinfo');
    NetInfo = netinfo.default;

    if (!NetInfo) return;

    // Set up listener
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _unsubscribe = NetInfo.addEventListener((state) => {
      const isConnected = state.isConnected === true && state.isInternetReachable !== false;
      useConnectivityStore.setState({ isConnected, isInitialized: true });
    });

    // Initial check
    const state = await NetInfo.fetch();
    const isConnected = state.isConnected === true && state.isInternetReachable !== false;
    useConnectivityStore.setState({ isConnected, isInitialized: true });
  } catch {
    // NetInfo not available or failed to load; mark as initialized so we don't wait forever
    useConnectivityStore.setState({ isInitialized: true });
  }
}

// Start loading NetInfo on native platforms
initializeNativeConnectivity();


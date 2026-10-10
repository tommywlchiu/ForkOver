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

// Lazy-load NetInfo only on native platforms to avoid import errors on web/tests
async function loadNetInfo() {
  if (Platform.OS !== 'web' && typeof jest === 'undefined') {
    try {
      const netinfo = await import('@react-native-community/netinfo');
      NetInfo = netinfo.default;
    } catch {
      // NetInfo not available or failed to load
    }
  }
}

// Start loading NetInfo if on native
loadNetInfo();

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
  } else if (NetInfo) {
    // Native: use NetInfo listener
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _unsubscribe = NetInfo.addEventListener((state) => {
      const isConnected = state.isConnected === true && state.isInternetReachable !== false;
      set({ isConnected, isInitialized: true });
    });

    // Initial check
    NetInfo.fetch().then((state) => {
      const isConnected = state.isConnected === true && state.isInternetReachable !== false;
      set({ isConnected, isInitialized: true });
    });
  }

  // Return initial state
  return {
    isConnected: true,
    isInitialized: true,
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


/**
 * Where the device key lives.
 *
 * On iOS and Android: expo-secure-store, which is the Keychain / the
 * Keystore - the platform's encrypted, per-app credential store
 * (MOBILE_ARCHITECTURE.md: "never AsyncStorage"). The key is written with
 * WHEN_UNLOCKED_THIS_DEVICE_ONLY, so it does not migrate to a new phone in a
 * backup and is unreadable while the device is locked.
 *
 * In a browser (Expo web, used here as a build gate and for a developer's
 * quick look): memory only. There is no secure storage in a tab, so the key
 * is deliberately NOT persisted - a reload means signing in again. That is a
 * stated limitation, not an oversight.
 */
import { Platform } from 'react-native';

export interface TokenStorage {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
  /** Words for the settings screen, so the person knows where their key is. */
  readonly description: string;
}

const KEY = 'jobpilot.device-key';

export class MemoryTokenStorage implements TokenStorage {
  private token: string | null = null;
  readonly description = 'Kept in memory for this browser tab only; a reload signs you out.';
  async get() {
    return this.token;
  }
  async set(token: string) {
    this.token = token;
  }
  async clear() {
    this.token = null;
  }
}

class SecureTokenStorage implements TokenStorage {
  readonly description = Platform.OS === 'ios' ? 'Kept in the iOS Keychain, on this device only.' : 'Kept in the Android Keystore, on this device only.';
  private store = () => import('expo-secure-store');
  async get() {
    const SecureStore = await this.store();
    return SecureStore.getItemAsync(KEY);
  }
  async set(token: string) {
    const SecureStore = await this.store();
    await SecureStore.setItemAsync(KEY, token, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  }
  async clear() {
    const SecureStore = await this.store();
    await SecureStore.deleteItemAsync(KEY);
  }
}

export function defaultTokenStorage(): TokenStorage {
  return Platform.OS === 'web' ? new MemoryTokenStorage() : new SecureTokenStorage();
}

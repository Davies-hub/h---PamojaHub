// Token storage — ONE async contract, platform-split implementation.
//
// WEB uses localStorage (XSS-readable) — acceptable for DEV only; production web
// would need httpOnly cookies. NATIVE uses Keychain/Keystore (secure) via
// expo-secure-store. All methods are async (web's localStorage calls are wrapped)
// so every caller has a single `await`-able contract regardless of platform.

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

export type TokenKey = 'accessToken' | 'refreshToken';

const isWeb = Platform.OS === 'web';

export async function setToken(key: TokenKey, value: string): Promise<void> {
  if (isWeb) {
    window.localStorage.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

export async function getToken(key: TokenKey): Promise<string | null> {
  if (isWeb) {
    return window.localStorage.getItem(key);
  }
  return SecureStore.getItemAsync(key);
}

export async function deleteToken(key: TokenKey): Promise<void> {
  if (isWeb) {
    window.localStorage.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

// Removes BOTH tokens — used on logout and on a hard 401 (dead session).
export async function clearTokens(): Promise<void> {
  await Promise.all([deleteToken('accessToken'), deleteToken('refreshToken')]);
}

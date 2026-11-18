'use strict';

/**
 * token 持久化：iOS/Android 都用 expo-secure-store（系统钥匙串 / Keystore）。
 * 抽成 { get, set, clear } 是为了让 client 在测试里用内存实现。
 */

const SecureStore = require('expo-secure-store');

const KEY = 'refillpal.token';

const secureTokenStore = {
  async get() {
    try {
      return await SecureStore.getItemAsync(KEY);
    } catch (e) {
      return null;
    }
  },
  async set(value) {
    try {
      await SecureStore.setItemAsync(KEY, String(value));
    } catch (e) {
      /* 存不下就退化成仅本次会话有效 */
    }
  },
  async clear() {
    try {
      await SecureStore.deleteItemAsync(KEY);
    } catch (e) {
      /* ignore */
    }
  }
};

module.exports = { secureTokenStore, KEY };

/** 本地缓存（wx.setStorageSync 的薄封装，带 TTL，永不抛异常） */

const KEY_PREFIX = 'refillpal:';

function set(key, value, ttl) {
  try {
    wx.setStorageSync(KEY_PREFIX + key, {
      value,
      expireAt: ttl ? Date.now() + ttl : 0
    });
    return true;
  } catch (e) {
    return false;
  }
}

function get(key, fallback = null) {
  try {
    const raw = wx.getStorageSync(KEY_PREFIX + key);
    if (!raw || typeof raw !== 'object') return fallback;
    if (raw.expireAt && Date.now() > raw.expireAt) {
      remove(key);
      return fallback;
    }
    return raw.value === undefined ? fallback : raw.value;
  } catch (e) {
    return fallback;
  }
}

function remove(key) {
  try {
    wx.removeStorageSync(KEY_PREFIX + key);
  } catch (e) {
    /* ignore */
  }
}

function clear() {
  try {
    const info = wx.getStorageInfoSync();
    (info.keys || [])
      .filter((k) => k.indexOf(KEY_PREFIX) === 0)
      .forEach((k) => wx.removeStorageSync(k));
  } catch (e) {
    /* ignore */
  }
}

module.exports = { set, get, remove, clear, KEY_PREFIX };

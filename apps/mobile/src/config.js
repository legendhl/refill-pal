'use strict';

/**
 * 运行时配置。
 *
 * App 的接口地址在构建时注入（Expo 会内联 EXPO_PUBLIC_ 开头的环境变量）：
 *   EXPO_PUBLIC_API_BASE_URL=https://api.example.com npx expo start
 *
 * 开发期用局域网 IP 即可，例如 http://192.168.1.10:3000
 * （域名与备案下来后再换成 https 域名，代码不需要改）
 */

const DEFAULT_DEV_BASE_URL = 'http://127.0.0.1:3000';

const fromEnv =
  typeof process !== 'undefined' && process.env && process.env.EXPO_PUBLIC_API_BASE_URL
    ? String(process.env.EXPO_PUBLIC_API_BASE_URL)
    : '';

const API_BASE_URL = (fromEnv || DEFAULT_DEV_BASE_URL).replace(/\/+$/, '');

/** 提醒时刻（本地时间的小时数）与提前量默认值；实际以后端家庭设置为准 */
const NOTIFY_HOUR = 9;
const HORIZON_DAYS = 30;

module.exports = { API_BASE_URL, NOTIFY_HOUR, HORIZON_DAYS };

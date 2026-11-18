'use strict';

/**
 * 配置全部来自环境变量（systemd 的 EnvironmentFile 里放着），不进代码。
 * 本地开发可以建一个 .env 风格的 shell 文件后 source 它。
 */

const path = require('node:path');

function load(env = process.env) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT 不合法：${env.PORT}`);
  }

  const host = env.HOST || '127.0.0.1';
  const dbFile = env.DB_FILE || path.join(process.cwd(), 'data', 'refillpal.db');
  const jwtTtl = Number(env.JWT_TTL_SECONDS || 30 * 24 * 60 * 60);

  let jwtSecret = env.JWT_SECRET || '';
  const isProduction = env.NODE_ENV === 'production';

  if (!jwtSecret) {
    if (isProduction) {
      throw new Error('生产环境必须设置 JWT_SECRET（至少 32 个随机字符）');
    }
    // 开发环境允许随机生成，但重启后旧 token 会失效 —— 打日志提醒
    jwtSecret = require('node:crypto').randomBytes(32).toString('hex');
    console.warn('[config] 未设置 JWT_SECRET，已随机生成（重启后登录态失效）。生产环境请务必设置。');
  } else if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET 太短，至少 32 个字符');
  }

  return {
    port,
    host,
    dbFile,
    jwtSecret,
    jwtTtl,
    corsOrigin: env.CORS_ORIGIN === undefined ? '*' : env.CORS_ORIGIN,
    isProduction
  };
}

module.exports = { load };

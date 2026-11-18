'use strict';

/**
 * 服务端入口。
 *
 * 运行：node server/src/main.js
 * 环境变量：PORT / HOST / DB_FILE / JWT_SECRET / JWT_TTL_SECONDS / CORS_ORIGIN
 */

const path = require('node:path');
const config = require('./config');
const { createSqliteRepo } = require('./db/sqlite-repo');
const { createAuth } = require('./auth/service');
const { createApp } = require('./app');

const PKG = path.resolve(__dirname, '..', '..', 'packages', 'refillpal-core', 'src', 'server', 'handlers');

/** 业务模块：与小程序云函数共用同一份实现 */
const HANDLERS = {
  family: require(path.join(PKG, 'family')),
  item: require(path.join(PKG, 'item')),
  purchase: require(path.join(PKG, 'purchase')),
  dashboard: require(path.join(PKG, 'dashboard')),
  stats: require(path.join(PKG, 'stats'))
};

function main() {
  const cfg = config.load();
  const repo = createSqliteRepo({ file: cfg.dbFile });
  const auth = createAuth({ repo, secret: cfg.jwtSecret, ttlSeconds: cfg.jwtTtl });
  const { server } = createApp({
    repo,
    auth,
    handlers: HANDLERS,
    corsOrigin: cfg.corsOrigin,
    log: (level, message, extra) => {
      const line = `[${level}] ${message}` + (extra ? ` ${JSON.stringify(extra)}` : '');
      if (level === 'error') console.error(line);
      else console.log(line);
    }
  });

  server.listen(cfg.port, cfg.host, () => {
    console.log(`RefillPal server listening on http://${cfg.host}:${cfg.port}`);
    console.log(`database: ${cfg.dbFile}`);
  });

  const shutdown = (signal) => {
    console.log(`\n收到 ${signal}，正在关闭…`);
    server.close(() => {
      repo.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { server, repo };
}

if (require.main === module) main();

module.exports = { main, HANDLERS };

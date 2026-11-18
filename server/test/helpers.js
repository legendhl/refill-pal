'use strict';

/** 测试辅助：起一个真实的 HTTP 服务（内存 SQLite），返回 fetch 封装 */

const path = require('node:path');
const { createSqliteRepo } = require('../src/db/sqlite-repo');
const { createAuth } = require('../src/auth/service');
const { createApp } = require('../src/app');

const PKG = path.resolve(__dirname, '..', '..', 'packages', 'refillpal-core', 'src', 'server', 'handlers');

const HANDLERS = {
  family: require(path.join(PKG, 'family')),
  item: require(path.join(PKG, 'item')),
  purchase: require(path.join(PKG, 'purchase')),
  dashboard: require(path.join(PKG, 'dashboard')),
  stats: require(path.join(PKG, 'stats'))
};

const TEST_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

async function startTestServer(options = {}) {
  const repo = createSqliteRepo({ file: ':memory:' });
  const auth = createAuth({
    repo,
    secret: options.secret || TEST_SECRET,
    ttlSeconds: options.ttlSeconds === undefined ? 3600 : options.ttlSeconds
  });
  const { server } = createApp({ repo, auth, handlers: HANDLERS, log: () => {} });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    repo,
    auth,
    server,
    port,
    secret: TEST_SECRET,

    /** api('POST', '/api/family/create', { body, token }) */
    async api(method, urlPath, { body, token } = {}) {
      const headers = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },

    /** 注册一个用户并返回 { token, user, identity } */
    async registerUser(email, password = 'password123', nickName) {
      const res = await this.api('POST', '/api/auth/register', {
        body: { email, password, nickName }
      });
      if (!res.body || !res.body.ok) {
        throw new Error(`注册失败：${JSON.stringify(res.body)}`);
      }
      return res.body.data;
    },

    async close() {
      await new Promise((resolve) => server.close(resolve));
      repo.close();
    }
  };
}

module.exports = { startTestServer, HANDLERS, TEST_SECRET };

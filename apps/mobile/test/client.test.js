'use strict';

/** API 客户端：错误映射、token 持久化、URL 拼接 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createClient, ApiError, joinUrl } = require('../src/api/client');

function memStore(initial) {
  let value = initial || null;
  return {
    get: async () => value,
    set: async (v) => {
      value = v;
    },
    clear: async () => {
      value = null;
    },
    peek: () => value
  };
}

function jsonResponse(status, body) {
  return {
    status,
    json: async () => body
  };
}

test('joinUrl：去掉多余的斜杠', () => {
  assert.equal(joinUrl('https://api.example.com/', '/api/health'), 'https://api.example.com/api/health');
  assert.equal(joinUrl('https://api.example.com', '/api/health'), 'https://api.example.com/api/health');
});

test('成功：返回 data，并带上 Authorization', async () => {
  const calls = [];
  const client = createClient({
    baseUrl: 'https://api.test',
    token: 'tok-1',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, { ok: true, data: { hello: 1 } });
    }
  });

  const data = await client.call('item', 'list', { q: 1 });
  assert.deepEqual(data, { hello: 1 });
  assert.equal(calls[0].url, 'https://api.test/api/item/list');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok-1');
  assert.equal(calls[0].init.body, JSON.stringify({ q: 1 }));
});

test('业务失败：抛出带 code 的 ApiError', async () => {
  const client = createClient({
    baseUrl: 'https://api.test',
    fetchImpl: async () => jsonResponse(409, { ok: false, code: 'ALREADY_IN_FAMILY', message: '你已经在家庭里了' })
  });

  await assert.rejects(
    () => client.call('family', 'create', {}),
    (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.code, 'ALREADY_IN_FAMILY');
      assert.equal(e.status, 409);
      assert.equal(e.message, '你已经在家庭里了');
      return true;
    }
  );
});

test('网络错误：转成 NETWORK，方便界面提示重试', async () => {
  const client = createClient({
    baseUrl: 'https://api.test',
    fetchImpl: async () => {
      throw new Error('fetch failed');
    }
  });

  await assert.rejects(
    () => client.call('item', 'list', {}),
    (e) => e.code === 'NETWORK' && /检查网络/.test(e.message)
  );
});

test('返回不是 JSON：转成 BAD_RESPONSE', async () => {
  const client = createClient({
    baseUrl: 'https://api.test',
    fetchImpl: async () => ({
      status: 502,
      json: async () => {
        throw new Error('not json');
      }
    })
  });

  await assert.rejects(
    () => client.call('item', 'list', {}),
    (e) => e.code === 'BAD_RESPONSE' && e.status === 502
  );
});

test('登录成功后自动保存 token，退出后清空', async () => {
  const store = memStore();
  const client = createClient({
    baseUrl: 'https://api.test',
    tokenStore: store,
    fetchImpl: async () =>
      jsonResponse(200, { ok: true, data: { token: 'tok-login', user: { _id: 'u1' } } })
  });

  await client.login({ email: 'a@b.com', password: 'password123' });
  assert.equal(client.getToken(), 'tok-login');
  assert.equal(store.peek(), 'tok-login');

  await client.logout();
  assert.equal(client.getToken(), null);
  assert.equal(store.peek(), null);
});

test('启动时能从存储里恢复 token', async () => {
  const store = memStore('tok-restored');
  const seen = [];
  const client = createClient({
    baseUrl: 'https://api.test',
    tokenStore: store,
    fetchImpl: async (url, init) => {
      seen.push(init.headers.authorization);
      return jsonResponse(200, { ok: true, data: { user: { _id: 'u1' } } });
    }
  });

  await client.me();
  assert.equal(seen[0], 'Bearer tok-restored');
});

test('me 与 health 走 GET', async () => {
  const methods = [];
  const client = createClient({
    baseUrl: 'https://api.test',
    fetchImpl: async (url, init) => {
      methods.push(`${init.method} ${url}`);
      return jsonResponse(200, { ok: true, data: {} });
    }
  });

  await client.me();
  await client.health();
  assert.deepEqual(methods, [
    'GET https://api.test/api/auth/me',
    'GET https://api.test/api/health'
  ]);
});

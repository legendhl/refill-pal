'use strict';

/**
 * 端到端测试：真的起一个 HTTP 服务，走完整的「注册 → 建家 → 记一笔 → 看首页」。
 *
 * 这层验证的是「服务端把 packages 里的 handler 正确接上了」，以及身份、
 * 归属校验、错误码在真实 HTTP 语义下是否成立。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer } = require('./helpers');

function ok(res) {
  assert.equal(res.body && res.body.ok, true, `期望成功，实际：${JSON.stringify(res.body)}`);
  return res.body.data;
}

test('健康检查', async () => {
  const srv = await startTestServer();
  try {
    const res = await srv.api('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'ok');
  } finally {
    await srv.close();
  }
});

test('注册 → 登录 → me', async () => {
  const srv = await startTestServer();
  try {
    const reg = await srv.api('POST', '/api/auth/register', {
      body: { email: 'dad@example.com', password: 'password123', nickName: '爸爸' }
    });
    assert.equal(reg.status, 201);
    const data = ok(reg);
    assert.equal(data.user.email, 'dad@example.com');
    assert.ok(data.token);
    assert.equal(data.user.passwordHash, undefined);

    const login = await srv.api('POST', '/api/auth/login', {
      body: { email: 'dad@example.com', password: 'password123' }
    });
    assert.equal(login.status, 200);
    assert.ok(ok(login).token);

    const bad = await srv.api('POST', '/api/auth/login', {
      body: { email: 'dad@example.com', password: 'nope-nope' }
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.code, 'BAD_CREDENTIALS');

    const me = await srv.api('GET', '/api/auth/me', { token: data.token });
    assert.equal(me.status, 200);
    assert.equal(ok(me).user.email, 'dad@example.com');
    assert.equal(ok(me).family, null, '还没建家庭时 family 应为 null');
  } finally {
    await srv.close();
  }
});

test('重复注册返回 409，未登录访问业务接口返回 401', async () => {
  const srv = await startTestServer();
  try {
    await srv.registerUser('a@b.com');
    const dup = await srv.api('POST', '/api/auth/register', {
      body: { email: 'a@b.com', password: 'password123' }
    });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, 'EMAIL_TAKEN');

    const noAuth = await srv.api('POST', '/api/item/list', { body: {} });
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.body.code, 'UNAUTHORIZED');
  } finally {
    await srv.close();
  }
});

test('建家庭 → 加物品 → 记一笔 → 首页能看到', async () => {
  const srv = await startTestServer();
  try {
    const { token } = await srv.registerUser('mom@example.com', 'password123', '妈妈');

    const created = ok(await srv.api('POST', '/api/family/create', { body: { name: '我家' }, token }));
    assert.equal(created.family.name, '我家');
    assert.equal(created.me.role, 'owner');

    const item = ok(
      await srv.api('POST', '/api/item/create', {
        body: { name: '抽纸', category: '纸品', unit: '包', baseQty: 1, initEstimateDays: 1 },
        token
      })
    );
    assert.equal(item.item.name, '抽纸');
    assert.equal(item.item.stock, 1);

    const bought = ok(
      await srv.api('POST', '/api/purchase/add', {
        body: { entries: [{ itemId: item.item._id, qty: 2, amount: 39.9, channel: '超市' }] },
        token
      })
    );
    assert.equal(bought.created.length, 1);
    assert.equal(bought.items[0].stock, 3);

    const home = ok(await srv.api('POST', '/api/dashboard/home', { body: {}, token }));
    assert.equal(home.needOnboarding, false);
    assert.equal(home.family.name, '我家');
    assert.equal(home.summary.itemCount, 1);
    assert.equal(home.summary.monthTotal, 39.9);
    assert.equal(home.refill.length, 1, '1 天用完 + 提前 3 天提醒 → 应该进待补货');
    assert.equal(home.ok.length, 0);

    const stats = ok(await srv.api('POST', '/api/stats/monthly', { body: {}, token }));
    assert.equal(stats.current.total, 39.9);
    assert.equal(stats.rank[0].name, '抽纸');
  } finally {
    await srv.close();
  }
});

test('归属安全：别人家的物品读不到、也改不了', async () => {
  const srv = await startTestServer();
  try {
    const a = await srv.registerUser('a@example.com', 'password123');
    const b = await srv.registerUser('b@example.com', 'password123');

    ok(await srv.api('POST', '/api/family/create', { body: { name: 'A 家' }, token: a.token }));
    const created = ok(
      await srv.api('POST', '/api/item/create', { body: { name: '抽纸', unit: '包' }, token: a.token })
    );
    const foreignId = created.item._id;

    ok(await srv.api('POST', '/api/family/create', { body: { name: 'B 家' }, token: b.token }));

    const list = ok(await srv.api('POST', '/api/item/list', { body: {}, token: b.token }));
    assert.equal(list.items.length, 0, 'B 不该看到 A 的物品');

    const detail = await srv.api('POST', '/api/item/detail', { body: { itemId: foreignId }, token: b.token });
    assert.equal(detail.status, 404);
    assert.equal(detail.body.code, 'ITEM_NOT_FOUND');

    const purchase = await srv.api('POST', '/api/purchase/add', {
      body: { entries: [{ itemId: foreignId, qty: 1 }] },
      token: b.token
    });
    assert.equal(purchase.status, 404);

    // A 的数据没被动过
    const mine = ok(await srv.api('POST', '/api/item/list', { body: {}, token: a.token }));
    assert.equal(mine.items.length, 1);
  } finally {
    await srv.close();
  }
});

test('家庭成员共享：第二个账号加入后看到同一份数据', async () => {
  const srv = await startTestServer();
  try {
    const dad = await srv.registerUser('dad@example.com', 'password123', '爸爸');
    const mom = await srv.registerUser('mom@example.com', 'password123', '妈妈');

    const family = ok(await srv.api('POST', '/api/family/create', { body: { name: '我家' }, token: dad.token }));
    ok(
      await srv.api('POST', '/api/item/create', {
        body: { name: '抽纸', unit: '包', baseQty: 5, initEstimateDays: 30 },
        token: dad.token
      })
    );

    const joined = ok(
      await srv.api('POST', '/api/family/join', {
        body: { inviteCode: family.family.inviteCode },
        token: mom.token
      })
    );
    assert.equal(joined.members.length, 2);

    const list = ok(await srv.api('POST', '/api/item/list', { body: {}, token: mom.token }));
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].stock, 5);
  } finally {
    await srv.close();
  }
});

test('错误处理：未知接口 404、非法 JSON 400、非法入参 400', async () => {
  const srv = await startTestServer();
  try {
    const { token } = await srv.registerUser('x@example.com');

    const unknownFn = await srv.api('POST', '/api/nope/list', { body: {}, token });
    assert.equal(unknownFn.status, 404);

    const unknownAction = await srv.api('POST', '/api/item/nope', { body: {}, token });
    assert.equal(unknownAction.status, 400);
    assert.equal(unknownAction.body.code, 'UNKNOWN_ACTION');

    const badJson = await fetch(`http://127.0.0.1:${srv.port}/api/item/list`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{not json'
    });
    assert.equal(badJson.status, 400);

    ok(await srv.api('POST', '/api/family/create', { body: {}, token }));
    const invalid = await srv.api('POST', '/api/item/create', { body: { name: '  ' }, token });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'INVALID_INPUT');
  } finally {
    await srv.close();
  }
});

test('没有加入家庭时，业务接口返回 NO_FAMILY（客户端据此跳引导页）', async () => {
  const srv = await startTestServer();
  try {
    const { token } = await srv.registerUser('new@example.com');
    const res = await srv.api('POST', '/api/item/list', { body: {}, token });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'NO_FAMILY');
  } finally {
    await srv.close();
  }
});

test('登录限流：同一来源一分钟内尝试过多返回 429', async () => {
  const srv = await startTestServer();
  try {
    await srv.registerUser('limit@example.com', 'password123');

    let last = null;
    for (let i = 0; i < 25; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      last = await srv.api('POST', '/api/auth/login', {
        body: { email: 'limit@example.com', password: 'wrong-password' }
      });
    }
    assert.equal(last.status, 429);
    assert.equal(last.body.code, 'RATE_LIMITED');
  } finally {
    await srv.close();
  }
});

test('限流不影响正常业务的连续调用', async () => {
  const srv = await startTestServer();
  try {
    const { token } = await srv.registerUser('burst@example.com', 'password123');
    ok(await srv.api('POST', '/api/family/create', { body: { name: '我家' }, token }));

    for (let i = 0; i < 30; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await srv.api('POST', '/api/item/list', { body: {}, token });
      assert.equal(res.status, 200, `第 ${i + 1} 次调用被限流了`);
    }
  } finally {
    await srv.close();
  }
});

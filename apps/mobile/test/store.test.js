'use strict';

/**
 * 状态层集成测试：移动端的 store → 真实 HTTP 服务端 → SQLite。
 *
 * 这一条链路打通了，说明「App 的调用形状」和「服务端的入参出参」是真对得上的，
 * 而不只是各自单测通过。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer } = require('../../../server/test/helpers');
const { createClient } = require('../src/api/client');
const { createStore } = require('../src/state/store');

async function setup() {
  const srv = await startTestServer();
  const client = createClient({
    baseUrl: `http://127.0.0.1:${srv.port}`,
    fetchImpl: fetch
  });
  const store = createStore({ client, now: () => new Date() });
  return { srv, client, store };
}

test('未登录时 bootstrap 进入匿名态', async () => {
  const { srv, store } = await setup();
  try {
    await store.bootstrap();
    assert.equal(store.getState().status, 'anon');
  } finally {
    await srv.close();
  }
});

test('注册 → 建家 → 加物品 → 记一笔，状态逐级更新', async () => {
  const { srv, store } = await setup();
  try {
    await store.register('app@example.com', 'password123', '我');
    let state = store.getState();
    assert.equal(state.status, 'ready');
    assert.equal(state.user.email, 'app@example.com');
    assert.equal(state.family, null, '还没建家庭');

    await store.createFamily('我家');
    state = store.getState();
    assert.equal(state.family.name, '我家');
    assert.equal(state.members.length, 1);

    const created = await store.createItem({
      name: '抽纸',
      unit: '包',
      category: '纸品',
      baseQty: 1,
      initEstimateDays: 1
    });
    state = store.getState();
    assert.equal(state.items.length, 1);
    const itemId = state.items[0]._id;
    assert.equal(state.items[0].stock, 1);

    // 预估 1 天用完、提前 3 天提醒 → 今天就该提醒
    assert.equal(state.schedule.length, 1, '应该排出一条本地通知');
    assert.equal(state.schedule[0].itemId, itemId);

    await store.quickAdd(itemId, 2);
    state = store.getState();
    assert.equal(state.items[0].stock, 3, '加购后库存应刷新');
    void created;
  } finally {
    await srv.close();
  }
});

test('退出登录后状态清空，token 不再发送', async () => {
  const { srv, client, store } = await setup();
  try {
    await store.register('a@example.com', 'password123');
    await store.createFamily('我家');
    assert.ok(store.getState().family);

    await store.logout();
    assert.equal(store.getState().status, 'anon');
    assert.equal(store.getState().family, null);
    assert.equal(client.getToken(), null);
  } finally {
    await srv.close();
  }
});

test('未加入家庭时，dashboard 返回 needOnboarding → 进入引导态', async () => {
  const { srv, store } = await setup();
  try {
    await store.register('b@example.com', 'password123');
    const state = store.getState();
    assert.equal(state.status, 'ready');
    assert.equal(state.family, null);
    assert.equal(state.dashboard, null);
    assert.deepEqual(state.schedule, []);
  } finally {
    await srv.close();
  }
});

test('加入别人的家庭后能看到同一份数据', async () => {
  const { srv } = await setup();
  try {
    // 用两个独立客户端模拟两个人
    const dadClient = createClient({ baseUrl: `http://127.0.0.1:${srv.port}`, fetchImpl: fetch });
    const dad = createStore({ client: dadClient });
    await dad.register('dad2@example.com', 'password123', '爸爸');
    const family = await dad.createFamily('我家');
    await dad.createItem({ name: '洗手液', unit: '瓶', baseQty: 2, initEstimateDays: 30 });

    const momClient = createClient({ baseUrl: `http://127.0.0.1:${srv.port}`, fetchImpl: fetch });
    const mom = createStore({ client: momClient });
    await mom.register('mom2@example.com', 'password123', '妈妈');
    await mom.joinFamily(family.inviteCode, '妈妈');

    const state = mom.getState();
    assert.equal(state.family.name, '我家');
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0].name, '洗手液');
  } finally {
    await srv.close();
  }
});

test('登录失败时把错误信息留在 state 里，界面可直接展示', async () => {
  const { srv, store } = await setup();
  try {
    await store.register('c@example.com', 'password123');
    await store.logout();

    await assert.rejects(() => store.login('c@example.com', 'wrong-password'));
    assert.equal(store.getState().status, 'anon');
    assert.match(store.getState().error, /邮箱或密码/);
  } finally {
    await srv.close();
  }
});

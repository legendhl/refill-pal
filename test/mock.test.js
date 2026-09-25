'use strict';

/**
 * 演示模式（mock）测试 + 与真实云函数的**结构一致性**测试。
 *
 * 结构一致性很重要：演示模式存在的意义是「先用 UI 看效果，再开通云开发」，
 * 如果两边的返回结构不一样，接上云的那一刻界面就会崩。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const mock = require('../miniprogram/utils/mock');
const { createFakeDb, resetIdSeq } = require('../test-utils/fake-db');

const dashboardApp = require('../cloudfunctions/dashboard/app');
const itemApp = require('../cloudfunctions/item/app');
const familyApp = require('../cloudfunctions/family/app');
const statsApp = require('../cloudfunctions/stats/app');
const purchaseApp = require('../cloudfunctions/purchase/app');

function memStorage() {
  let value = null;
  return {
    get: () => (value === null ? null : JSON.parse(JSON.stringify(value))),
    set: (v) => {
      value = JSON.parse(JSON.stringify(v));
    },
    clear: () => {
      value = null;
    }
  };
}

function fresh() {
  mock.init({ latency: 0, storage: memStorage() });
  return mock;
}

async function callM(name, action, payload) {
  const res = await mock.call(name, action, payload);
  return res;
}

function ok(res) {
  assert.equal(res.ok, true, `期望成功，实际：${JSON.stringify(res)}`);
  return res.data;
}

// ============================================================ 演示数据本身

test('演示数据覆盖了所有界面状态：已用完 / 快用完 / 数据不足 / 盘点校准过 / 换过规格', async () => {
  fresh();
  const home = ok(await callM('dashboard', 'home'));

  assert.equal(home.needOnboarding, false);
  assert.equal(home.family.name, '我家');
  assert.equal(home.members.length, 2);

  const refillNames = home.refill.map((r) => r.name);
  assert.deepEqual(refillNames, ['抽纸', '洗手液'], '第一屏应该正好有 2 样该买');

  const overdue = home.refill.filter((r) => r.stock <= 0);
  assert.equal(overdue.length, 1, '要有 1 样是已用完的状态');
  assert.equal(overdue[0].name, '抽纸');
  assert.equal(overdue[0].level, 'overdue');

  const okNames = home.ok.map((r) => r.name);
  assert.deepEqual(okNames, ['洗衣液', '垃圾袋', '牙膏', '洗发水'], '还够用按剩余天数升序，无法估算的排最后');

  const shampoo = home.ok.find((r) => r.name === '洗发水');
  assert.equal(shampoo.estimable, false, '只记过一次的物品要如实显示为无法估算');

  const tooth = home.ok.find((r) => r.name === '牙膏');
  assert.equal(tooth.rateBasis, 'mixed', '牙膏应该走过盘点校准，展示混合估算');
  assert.ok(tooth.closedCycles >= 2);

  const paper = home.refill.find((r) => r.name === '抽纸');
  assert.equal(paper.specChanged, true, '抽纸中途换过规格，要能提示');
});

test('演示数据里本月有记录，统计页不会是空的', async () => {
  fresh();
  const stats = ok(await callM('stats', 'monthly', {}));
  assert.ok(stats.current.count >= 1, '本月应该至少有一笔购买');
  assert.ok(stats.current.total > 0);
  assert.equal(stats.trend.length, 6);
  assert.ok(stats.predicted.length >= 4, '大部分物品都应该能估算月开销');
  assert.ok(stats.predictedTotal > 0);
});

// ============================================================ 与云端结构一致

async function realFamilyContext() {
  resetIdSeq();
  const db = createFakeDb();
  const now = new Date();
  const deps = (openid) => ({ db, _: db.command, getOpenId: async () => openid, now: () => now });
  const dad = {
    family: (a, p) => familyApp.createApp(deps('openid-a')).handle({ action: a, payload: p }),
    item: (a, p) => itemApp.createApp(deps('openid-a')).handle({ action: a, payload: p }),
    stats: (a, p) => statsApp.createApp(deps('openid-a')).handle({ action: a, payload: p }),
    dashboard: (a, p) => dashboardApp.createApp(deps('openid-a')).handle({ action: a, payload: p }),
    purchase: (a, p) => purchaseApp.createApp(deps('openid-a')).handle({ action: a, payload: p })
  };
  ok(await dad.family('create', { name: '我家' }));
  ok(await dad.item('create', { name: '抽纸', unit: '包', category: '纸品', baseQty: 1, initEstimateDays: 1 }));
  ok(await dad.purchase('add', { entries: [{ itemId: (await dad.item('list')).data.items[0]._id, qty: 2, amount: 30 }] }));
  return dad;
}

function keysOf(obj) {
  return Object.keys(obj || {}).sort();
}

test('【结构一致】dashboard.home 的返回结构与真实云函数完全一致', async () => {
  fresh();
  const mockHome = ok(await callM('dashboard', 'home'));

  const real = await realFamilyContext();
  const realHome = ok(await real.dashboard('home'));

  assert.deepEqual(keysOf(mockHome), keysOf(realHome));
  assert.deepEqual(keysOf(mockHome.summary), keysOf(realHome.summary));
  assert.deepEqual(keysOf(mockHome.refill[0]), keysOf(realHome.refill[0]), '卡片字段必须一一对应');
  assert.deepEqual(keysOf(mockHome.family), keysOf(realHome.family));
  assert.deepEqual(keysOf(mockHome.me), keysOf(realHome.me));
});

test('【结构一致】stats.monthly 的返回结构完全一致', async () => {
  fresh();
  const mockStats = ok(await callM('stats', 'monthly', {}));

  const real = await realFamilyContext();
  const realStats = ok(await real.stats('monthly', {}));

  assert.deepEqual(keysOf(mockStats), keysOf(realStats));
  assert.deepEqual(keysOf(mockStats.current), keysOf(realStats.current));
  assert.deepEqual(keysOf(mockStats.predicted[0]), keysOf(realStats.predicted[0]));
  assert.deepEqual(keysOf(mockStats.trend[0]), keysOf(realStats.trend[0]));
});

test('【结构一致】purchase.frequent 与 item.detail 的结构一致', async () => {
  fresh();
  const mockFrequent = ok(await callM('purchase', 'frequent', { limit: 5 }));
  const real = await realFamilyContext();
  const realFrequent = ok(await real.purchase('frequent', { limit: 5 }));
  assert.deepEqual(keysOf(mockFrequent), keysOf(realFrequent));
  assert.deepEqual(keysOf(mockFrequent.items[0]), keysOf(realFrequent.items[0]));

  const realItemId = ok(await real.item('list')).items[0]._id;
  const mockItemId = mockFrequent.items[0]._id;
  const mockDetail = ok(await callM('item', 'detail', { itemId: mockItemId }));
  const realDetail = ok(await real.item('detail', { itemId: realItemId }));
  assert.deepEqual(keysOf(mockDetail), keysOf(realDetail));
  assert.deepEqual(keysOf(mockDetail.item), keysOf(realDetail.item));
  assert.deepEqual(keysOf(mockDetail.events[0]), keysOf(realDetail.events[0]));
  assert.deepEqual(keysOf(mockDetail.events[0]), keysOf(realDetail.events[0]));
});

// ============================================================ 演示模式的行为

test('记一笔：库存增加，首页与统计同步变化', async () => {
  const m = fresh();
  const before = ok(await callM('dashboard', 'home'));
  const paper = before.refill.find((r) => r.name === '抽纸');

  const added = ok(await callM('purchase', 'add', { entries: [{ itemId: paper._id, qty: 10, amount: 42 }] }));
  assert.equal(added.created.length, 1);
  assert.equal(added.items[0].stock, 10);

  const after = ok(await callM('dashboard', 'home'));
  assert.equal(after.refill.length, before.refill.length - 1, '买了之后应该少一样待补货');
  assert.ok(after.summary.monthTotal > before.summary.monthTotal);

  // 撤销后回到原状
  const removed = ok(await callM('purchase', 'remove', { eventIds: added.created }));
  assert.equal(removed.items[0].stock, 0);
  const restored = ok(await callM('dashboard', 'home'));
  assert.equal(restored.refill.length, before.refill.length);
  void m;
});

test('新建物品：重名校验与初始库存', async () => {
  fresh();
  const dup = await callM('item', 'create', { name: '抽纸' });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'DUPLICATE_NAME');

  const empty = await callM('item', 'create', { name: '  ' });
  assert.equal(empty.code, 'INVALID_INPUT');

  const created = ok(await callM('item', 'create', { name: '保鲜膜', unit: '卷', baseQty: 2, initEstimateDays: 40 }));
  assert.equal(created.item.stock, 2);
  assert.equal(created.item.remainingDays, 40);

  const list = ok(await callM('item', 'list'));
  assert.equal(list.items.length, 7);
});

test('盘点：异常值要求二次确认，force 后才写入', async () => {
  fresh();
  const home = ok(await callM('dashboard', 'home'));
  const bag = home.ok.find((r) => r.name === '垃圾袋');

  const warn = ok(await callM('item', 'stocktake', { itemId: bag._id, remaining: 999 }));
  assert.equal(warn.confirmNeeded, true);

  const forced = ok(await callM('item', 'stocktake', { itemId: bag._id, remaining: 999, force: true }));
  assert.equal(forced.item.stock, 999);
});

test('用完：库存归零并进入待补货', async () => {
  fresh();
  const home = ok(await callM('dashboard', 'home'));
  const bag = home.ok.find((r) => r.name === '垃圾袋');

  const res = ok(await callM('item', 'usedUp', { itemId: bag._id }));
  assert.equal(res.item.stock, 0);
  assert.equal(res.item.level, 'overdue');

  const after = ok(await callM('dashboard', 'home'));
  assert.deepEqual(
    after.refill.map((r) => r.name),
    ['抽纸', '垃圾袋', '洗手液'],
    '刚用完的进入待补货，且逾期的排在最前'
  );
  assert.equal(after.summary.overdueCount, 2);
  assert.ok(
    after.refill.slice(0, 2).every((r) => r.level === 'overdue'),
    '两样逾期的必须都排在未逾期的前面'
  );
});

test('提醒设置：改提前天数立即影响待补货数量', async () => {
  fresh();
  const before = ok(await callM('dashboard', 'home'));
  assert.equal(before.refill.length, 2);

  ok(await callM('family', 'updateSettings', { remindDays: 7 }));
  const after = ok(await callM('dashboard', 'home'));
  assert.equal(after.remindDays, 7);
  assert.equal(after.refill.length, 3, '洗衣液还剩 5 天，提前 7 天就该提醒');

  const bad = await callM('family', 'updateSettings', { pushTime: '早上' });
  assert.equal(bad.code, 'INVALID_INPUT');
});

test('订阅额度：续订累加', async () => {
  fresh();
  const profile = ok(await callM('family', 'profile'));
  const start = profile.me.subQuota.remaining;
  ok(await callM('family', 'subscribe', { count: 3 }));
  const after = ok(await callM('family', 'profile'));
  assert.equal(after.me.subQuota.remaining, start + 3);
});

test('常用物品排序与未实现动作的兜底', async () => {
  fresh();
  const frequent = ok(await callM('purchase', 'frequent', { limit: 3 }));
  assert.equal(frequent.items.length, 3);
  assert.equal(frequent.items[0].name, '抽纸', '待补货的排最前');

  const unknown = await callM('item', 'notImplementedYet', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'UNKNOWN_ACTION');
});

test('reset：演示数据可以一键还原', async () => {
  const m = fresh();
  ok(await callM('item', 'create', { name: '临时物品' }));
  assert.equal(ok(await callM('item', 'list')).items.length, 7);

  ok(await m.call('mock', 'reset', {}));
  assert.equal(ok(await callM('item', 'list')).items.length, 6);
});

test('演示数据持久化：重进小程序还是你改过的样子', async () => {
  const storage = memStorage();
  mock.init({ latency: 0, storage });
  ok(await callM('item', 'create', { name: '持久化测试' }));

  // 模拟重新启动：同一份 storage 再 init 一次
  mock.init({ latency: 0, storage });
  const list = ok(await callM('item', 'list'));
  assert.equal(list.items.length, 7, '新建的物品应该还在');
  assert.ok(list.items.some((it) => it.name === '持久化测试'));
});

test('未加入家庭时演示模式返回引导态', async () => {
  mock.init({ latency: 0, storage: memStorage() });
  ok(await callM('family', 'leave'));
  const home = ok(await callM('dashboard', 'home'));
  assert.equal(home.needOnboarding, true);
  assert.equal(home.family, null);
});

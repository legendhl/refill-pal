'use strict';

/**
 * 页面级测试：把 Node 当成小程序的运行环境，真的把页面跑起来。
 *
 * 覆盖两类问题：
 *   1. 静态一致性：WXML 里绑的事件处理函数必须存在；{{}} 引用的字段必须在 data 里
 *   2. 交互行为：加载、记一笔、撤销、盘点、用完、设置保存、创建家庭等真实流程
 *
 * 这是在没有（可用）模拟器的情况下，能对界面逻辑做的最强验证。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWxStub } = require('../test-utils/wx-stub');
const mp = require('../test-utils/miniprogram');
const config = require('../miniprogram/config');

/**
 * 推送总开关默认是关的（config.js 的 PUSH_ENABLED）。
 * 要测推送相关界面时用 t.after(withPush(true)) 显式打开，测完自动还原。
 */
function withPush(enabled) {
  const original = config.PUSH_ENABLED;
  config.PUSH_ENABLED = enabled;
  return () => {
    config.PUSH_ENABLED = original;
  };
}

const PAGES = [
  'pages/home/home',
  'pages/items/items',
  'pages/stats/stats',
  'pages/me/me',
  'pages/item-detail/item-detail',
  'pages/item-edit/item-edit',
  'pages/family/family',
  'pages/settings/settings',
  'pages/onboarding/onboarding'
];

const COMPONENTS = ['components/item-card/item-card', 'components/empty-state/empty-state'];

const JS_LITERALS = new Set([
  'undefined',
  'null',
  'true',
  'false',
  'NaN',
  'Infinity',
  'typeof',
  'new',
  'in',
  'of',
  'void'
]);

/** 全新环境：清空存储、重置演示数据、把 latency 设成 0 */
function setup() {
  const stub = createWxStub();
  global.wx = stub.wx;
  stub.clearStorage();

  const api = require('../miniprogram/utils/api');
  api.init({ useMock: true, latency: 0 });

  const app = {
    globalData: { profile: null, bootCode: null },
    ready: async () => null,
    refreshProfile: async () => null
  };
  return { stub, app, api };
}

function allModules() {
  return PAGES.map((p) => ({ id: p, wxml: p }))
    .concat(COMPONENTS.map((c) => ({ id: c, wxml: c })));
}

// ============================================================ 静态一致性

test('WXML 里绑定的事件处理函数，页面 JS 里必须真的存在', () => {
  const missing = [];
  allModules().forEach((mod) => {
    const { stub, app } = setup();
    const instance = mp.loadPage(mod.id, { wx: stub.wx, app });
    const handlers = mp.wxmlHandlers(mod.wxml);
    assert.ok(handlers.size > 0, `${mod.id} 的 WXML 里一个事件绑定都没有？`);
    handlers.forEach((name) => {
      if (typeof instance[name] !== 'function') missing.push(`${mod.id} → ${name}`);
    });
  });
  assert.deepEqual(missing, [], `这些事件绑定的处理函数不存在：\n${missing.join('\n')}`);
});

test('WXML 里 {{}} 引用的字段必须出现在 data 或 setData 里（防止白屏/undefined）', () => {
  const unknown = [];
  allModules().forEach((mod) => {
    const { stub, app } = setup();
    const instance = mp.loadPage(mod.id, { wx: stub.wx, app });
    const known = new Set()
      .add ? new Set() : null;
    const keys = new Set(Object.keys(instance.data || {}));
    mp.setDataKeys(mod.wxml).forEach((k) => keys.add(k));
    mp.wxmlLoopAliases(mod.wxml).forEach((k) => keys.add(k));
    keys.add('wx');
    mp.wxmlIdentifiers(mod.wxml).forEach((id) => {
      if (JS_LITERALS.has(id)) return;
      if (!keys.has(id)) unknown.push(`${mod.id} → ${id}`);
    });
    void known;
  });
  assert.deepEqual(unknown, [], `这些字段在 WXML 里被引用但页面里没有：\n${unknown.join('\n')}`);
});

test('所有页面都注册进了 app.json，且 tabBar 四项能对应上', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const appJson = JSON.parse(fs.readFileSync(path.join(mp.MP, 'app.json'), 'utf8'));
  PAGES.forEach((p) => {
    assert.ok(appJson.pages.indexOf(p) >= 0, `${p} 未注册到 app.json`);
  });
  appJson.tabBar.list.forEach((tab) => {
    assert.ok(PAGES.indexOf(tab.pagePath) >= 0, `tabBar 的 ${tab.pagePath} 不在页面列表里`);
  });
});

// ============================================================ 首页

test('首页：加载演示数据后给出「2 样该买了」和一张该买的清单', async () => {
  const { stub, app } = setup();
  const home = mp.loadPage('pages/home/home', { wx: stub.wx, app });
  await home.onShow();
  await stub.flush();

  assert.equal(home.data.loading, false);
  assert.equal(home.data.offline, false);
  assert.equal(home.data.noFamily, false);
  assert.equal(home.data.summary.itemCount, 6);
  assert.equal(home.data.refill.length, 2);
  assert.deepEqual(
    home.data.refill.map((c) => c.name),
    ['抽纸', '洗手液']
  );
  assert.equal(home.data.refill[0].badge, '已用完');
  assert.equal(home.data.headline.title, '2 样该买了');
  assert.equal(home.data.headline.subtitle, '其中 1 样已经用完了');
  assert.equal(home.data.ok.length, 4);
  assert.equal(home.data.summary.monthTotalText, '89', '演示数据里本月有一笔 89 元');
  assert.equal(home.data.hasItems, true);
  assert.equal(
    home.data.showQuotaTip,
    false,
    '推送总开关关着的时候，首页不该出现续订提示'
  );
});

test('首页：推送总开关打开且额度不足时才提示续订', async (t) => {
  t.after(withPush(true));
  const { stub, app } = setup();
  const home = mp.loadPage('pages/home/home', { wx: stub.wx, app });
  await home.onShow();
  await stub.flush();

  assert.equal(home.data.quota, 2);
  assert.equal(home.data.showQuotaTip, true, '额度只剩 2 次，应该提示续订');
});

test('首页：推送总开关关闭时，续订方法直接返回不做任何事', async () => {
  const { stub, app, api } = setup();
  const home = mp.loadPage('pages/home/home', { wx: stub.wx, app });
  await home.onShow();
  await stub.flush();
  const before = home.data.quota;

  await home.requestSubscribe();
  await stub.flush();

  assert.equal(home.data.quota, before, '不该改动额度');
  assert.equal(stub.calls.toast.length, 0, '也不该弹任何提示');
  void api;
});

test('首页宫格：已用完的物品不重复显示两次「已用完」', async () => {
  const { stub, app } = setup();
  const home = mp.loadPage('pages/home/home', { wx: stub.wx, app });
  await home.onShow();
  await home.openSheet();
  await stub.flush();

  const paper = home.data.quickItems.find((c) => c.name === '抽纸');
  assert.equal(paper.shortText, '已用完');
  assert.equal(paper.showStock, false, '宫格第二行要藏起来，否则「已用完 / 已用完」');

  const soap = home.data.quickItems.find((c) => c.name === '洗手液');
  assert.equal(soap.showStock, true);
  assert.equal(soap.stockText, '不到 1 瓶', '不足 1 个单位时说人话');
});

test('首页：点开「记一笔」加载常用物品，待补货的排最前', async () => {
  const { stub, app } = setup();
  const home = mp.loadPage('pages/home/home', { wx: stub.wx, app });
  await home.onShow();
  await home.openSheet();
  await stub.flush();

  assert.equal(home.data.sheetVisible, true);
  assert.equal(home.data.quickLoading, false);
  assert.ok(home.data.quickItems.length >= 6);
  assert.equal(home.data.quickItems[0].name, '抽纸');
  assert.equal(home.data.quickItems[0].highlight, '#E5484D', '待补货的宫格要有高亮');
});

test('首页：点一下宫格就记上一笔，并给出撤销入口', async () => {
  const { stub, app } = setup();
  const home = mp.loadPage('pages/home/home', { wx: stub.wx, app });
  await home.onShow();
  await home.openSheet();
  await stub.flush();

  const paper = home.data.quickItems[0];
  await home.quickAdd({ currentTarget: { dataset: { id: paper.id } } });
  await stub.flush();

  assert.ok(home.data.undo, '应该出现撤销条');
  assert.match(home.data.undo.label, /抽纸 ×1/);
  assert.equal(stub.lastToast(), undefined, '成功时不弹 toast，靠撤销条反馈');

  // 宫格里的库存立刻更新（不用等首页刷新）
  const updated = home.data.quickItems.find((c) => c.id === paper.id);
  assert.equal(updated.stock, paper.stock + 1);

  // 等首页防抖刷新
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.ok(home.data.refill.length >= 1);
});

test('首页：长按宫格可以改数量', async () => {
  const { stub, app } = setup();
  const home = mp.loadPage('pages/home/home', { wx: stub.wx, app });
  await home.onShow();
  await home.openSheet();
  await stub.flush();

  const soap = home.data.quickItems.find((c) => c.name === '洗手液');
  stub.wx.__queueModal({ confirm: true, content: '3' });
  await home.quickAddLong({ currentTarget: { dataset: { id: soap.id } } });
  await stub.flush();

  assert.ok(home.data.undo);
  assert.match(home.data.undo.label, /洗手液 ×3/);
});

test('首页：撤销把刚记的那笔删掉，库存回退', async () => {
  const { stub, app } = setup();
  const home = mp.loadPage('pages/home/home', { wx: stub.wx, app });
  await home.onShow();
  await home.openSheet();
  await stub.flush();

  const soap = home.data.quickItems.find((c) => c.name === '洗手液');
  const before = soap.stock;
  await home.quickAdd({ currentTarget: { dataset: { id: soap.id } } });
  await stub.flush();
  const afterAdd = home.data.quickItems.find((c) => c.id === soap.id).stock;
  // 新买一笔会改变补货间隔 → 速率被重算 → 库存增量不是精确的 +1
  assert.ok(afterAdd > before, '加一笔之后库存要变多');
  assert.ok(
    Math.abs(afterAdd - before - 1) < 0.2,
    `库存增量应接近 1，实际 ${(afterAdd - before).toFixed(3)}`
  );

  await home.undoAdd();
  await stub.flush();

  assert.equal(home.data.undo, null);
  assert.equal(stub.lastToast().title, '已撤销');
  assert.equal(home.data.quickItems.find((c) => c.id === soap.id).stock, before);
});

test('首页：撤销窗口过期后条子自动消失', async () => {
  const { stub, app } = setup();
  const home = mp.loadPage('pages/home/home', { wx: stub.wx, app });
  await home.onShow();
  await home.openSheet();
  await stub.flush();

  const paper = home.data.quickItems[0];
  await home.quickAdd({ currentTarget: { dataset: { id: paper.id } } });
  await stub.flush();
  assert.ok(home.data.undo);

  // 撤销窗口默认 5 秒
  await new Promise((resolve) => setTimeout(resolve, 5300));
  assert.equal(home.data.undo, null);
});

test('首页：记完可以补金额，补完金额进入统计', async () => {
  const { stub, app, api } = setup();
  const home = mp.loadPage('pages/home/home', { wx: stub.wx, app });
  await home.onShow();
  await home.openSheet();
  await stub.flush();

  const paper = home.data.quickItems[0];
  await home.quickAdd({ currentTarget: { dataset: { id: paper.id } } });
  await stub.flush();

  stub.wx.__queueModal({ confirm: true, content: '39.9' });
  await home.fillAmount();
  await stub.flush();

  assert.equal(home.data.undo, null, '补完金额后撤销条应该收起');
  assert.equal(stub.lastToast().title, '已记上金额');

  const recent = await api.call('purchase', 'recent', { limit: 1 });
  assert.equal(recent.data.events[0].amount, 39.9);
});

test('首页：补金额填了非数字要拦住', async () => {
  const { stub, app } = setup();
  const home = mp.loadPage('pages/home/home', { wx: stub.wx, app });
  await home.onShow();
  await home.openSheet();
  await stub.flush();
  const paper = home.data.quickItems[0];
  await home.quickAdd({ currentTarget: { dataset: { id: paper.id } } });
  await stub.flush();

  stub.wx.__queueModal({ confirm: true, content: '三十九' });
  await home.fillAmount();
  await stub.flush();

  assert.equal(stub.lastToast().title, '金额要填数字');
  assert.ok(home.data.undo, '填错了不该把撤销条收掉');
});

test('首页：搜索能在本地过滤出物品', async () => {
  const { stub, app } = setup();
  const home = mp.loadPage('pages/home/home', { wx: stub.wx, app });
  await home.onShow();
  await home.openSheet();
  await stub.flush();

  await home.onSearch({ detail: { value: '洗衣' } });
  await stub.flush();
  assert.deepEqual(
    home.data.searchResults.map((c) => c.name),
    ['洗衣液']
  );

  await home.onSearch({ detail: { value: '不存在的' } });
  await stub.flush();
  assert.deepEqual(home.data.searchResults, []);
});

test('首页：没有家庭时显示引导而不是空列表', async () => {
  const { stub, app, api } = setup();
  await api.call('family', 'leave');

  const home = mp.loadPage('pages/home/home', { wx: stub.wx, app });
  await home.onShow();
  await stub.flush();

  assert.equal(home.data.noFamily, true);
  assert.equal(home.data.loading, false);
  home.goOnboarding();
  assert.equal(stub.calls.navigateTo[0].url, '/pages/onboarding/onboarding');
});

test('首页：点卡片进详情页，点「去添加物品」切到物品页', async () => {
  const { stub, app } = setup();
  const home = mp.loadPage('pages/home/home', { wx: stub.wx, app });
  await home.onShow();
  await stub.flush();

  home.openItem({ detail: { id: home.data.refill[0].id } });
  assert.match(stub.calls.navigateTo[0].url, /^\/pages\/item-detail\/item-detail\?id=/);
  home.goItems();
  assert.equal(stub.calls.switchTab[0].url, '/pages/items/items');
});

test('首页：分享清单在没有画布的环境里要优雅降级，不能崩', async () => {
  const { stub, app } = setup();
  const home = mp.loadPage('pages/home/home', { wx: stub.wx, app });
  await home.onShow();
  await stub.flush();

  // Node 环境的 wx 桩里没有 createSelectorQuery，走的是失败分支
  await home.sharePoster();
  await stub.flush();

  assert.equal(stub.lastToast().title, '生成清单图失败，稍后再试');
  assert.equal(stub.calls.actionSheet.length, 0, '没画出图就不该弹保存菜单');
});

test('首页：演示模式下点续订会走一遍额度流程', async (t) => {
  t.after(withPush(true));
  const { stub, app } = setup();
  const home = mp.loadPage('pages/home/home', { wx: stub.wx, app });
  await home.onShow();
  await stub.flush();
  const before = home.data.quota;

  await home.requestSubscribe();
  await stub.flush();

  assert.match(stub.lastToast().title, /已续订/);
  assert.equal(home.data.quota, before + 3);
});

// ============================================================ 物品页

test('物品页：按分类分组、可搜索', async () => {
  const { stub, app } = setup();
  const items = mp.loadPage('pages/items/items', { wx: stub.wx, app });
  await items.onShow();
  await stub.flush();

  assert.equal(items.data.total, 6);
  assert.ok(items.data.groups.length >= 4);
  const categories = items.data.groups.map((g) => g.category);
  assert.equal(categories[0], '纸品', '按预置分类顺序排');

  items.onSearch({ detail: { value: '洗' } });
  const names = items.data.groups.reduce((acc, g) => acc.concat(g.items.map((i) => i.name)), []);
  assert.deepEqual(names.sort(), ['洗手液', '洗衣液', '洗发水', '牙膏'].sort());
});

test('物品页：新建入口跳转到编辑页', async () => {
  const { stub, app } = setup();
  const items = mp.loadPage('pages/items/items', { wx: stub.wx, app });
  await items.onShow();
  items.goCreate();
  assert.equal(stub.calls.navigateTo[0].url, '/pages/item-edit/item-edit');
});

// ============================================================ 物品详情

test('物品详情：加载视图与时间轴，长按记录可改', async () => {
  const { stub, app, api } = setup();
  const list = await api.call('item', 'list');
  const paper = list.data.items.find((i) => i.name === '抽纸');

  const detail = mp.loadPage('pages/item-detail/item-detail', {
    wx: stub.wx,
    app,
    query: { id: paper._id }
  });
  await detail.onShow();
  await stub.flush();

  assert.equal(detail.data.loading, false);
  assert.equal(detail.data.card.name, '抽纸');
  assert.equal(detail.data.stockText, '已用完');
  assert.equal(detail.data.timeline.length, 3, '演示数据里抽纸有 2 次购买 + 1 次用完');
  assert.deepEqual(
    detail.data.timeline.map((t) => t.type),
    ['used_up', 'purchase', 'purchase']
  );
  assert.match(detail.data.basisText, /补货间隔/);
});

test('物品详情：已经用完时，「用完了」按钮变成禁用状态', async () => {
  const { stub, app, api } = setup();
  const list = await api.call('item', 'list');

  const paper = list.data.items.find((i) => i.name === '抽纸');
  const used = mp.loadPage('pages/item-detail/item-detail', {
    wx: stub.wx,
    app,
    query: { id: paper._id }
  });
  await used.onShow();
  await stub.flush();
  assert.equal(used.data.usedUpDisabled, true);
  assert.equal(used.data.usedUpLabel, '已经用完了');
  assert.equal(used.data.emptyPhrase, '', '已用完就不该再挂一个看起来像未来的日期');

  const bag = list.data.items.find((i) => i.name === '垃圾袋');
  const alive = mp.loadPage('pages/item-detail/item-detail', {
    wx: stub.wx,
    app,
    query: { id: bag._id }
  });
  await alive.onShow();
  await stub.flush();
  assert.equal(alive.data.usedUpDisabled, false);
  assert.equal(alive.data.usedUpLabel, '用完了');
  assert.match(alive.data.emptyPhrase, /^预计 .* 用完$/);
});

test('物品详情：盘点会校准库存，异常值要求二次确认', async () => {
  const { stub, app, api } = setup();
  const list = await api.call('item', 'list');
  const bag = list.data.items.find((i) => i.name === '垃圾袋');

  const detail = mp.loadPage('pages/item-detail/item-detail', {
    wx: stub.wx,
    app,
    query: { id: bag._id }
  });
  await detail.onShow();
  await stub.flush();

  // 正常盘点
  stub.wx.__queueModal({ confirm: true, content: '1' });
  await detail.stocktake();
  await stub.flush();
  assert.equal(detail.data.view.stock, 1);
  assert.equal(stub.lastToast().title, '已校准');

  // 异常值：第一次弹「还剩多少」，第二次弹确认
  stub.wx.__queueModal({ confirm: true, content: '999' });
  stub.wx.__queueModal({ confirm: true });
  await detail.stocktake();
  await stub.flush();
  assert.equal(detail.data.view.stock, 999);
});

test('物品详情：用完了会归零并进入待补货', async () => {
  const { stub, app, api } = setup();
  const list = await api.call('item', 'list');
  const bag = list.data.items.find((i) => i.name === '垃圾袋');

  const detail = mp.loadPage('pages/item-detail/item-detail', {
    wx: stub.wx,
    app,
    query: { id: bag._id }
  });
  await detail.onShow();
  await stub.flush();

  stub.wx.__queueModal({ confirm: true });
  await detail.usedUp();
  await stub.flush();

  assert.equal(detail.data.view.stock, 0);
  assert.equal(detail.data.card.badge, '已用完');
});

test('物品详情：记一笔会问数量和金额', async () => {
  const { stub, app, api } = setup();
  const list = await api.call('item', 'list');
  const soap = list.data.items.find((i) => i.name === '洗手液');

  const detail = mp.loadPage('pages/item-detail/item-detail', {
    wx: stub.wx,
    app,
    query: { id: soap._id }
  });
  await detail.onShow();
  await stub.flush();
  const before = detail.data.view.stock;

  stub.wx.__queueModal({ confirm: true, content: '2' }); // 数量
  stub.wx.__queueModal({ confirm: true }); // 要记金额吗 → 记一下
  stub.wx.__queueModal({ confirm: true, content: '26.9' }); // 金额
  await detail.buy();
  await stub.flush();

  // 新买一笔会改变补货间隔，速率会被重算，所以库存增量不是精确的 +2
  assert.ok(
    Math.abs(detail.data.view.stock - before - 2) < 0.2,
    `库存应该增加约 2，实际 ${before} → ${detail.data.view.stock}`
  );
  assert.equal(stub.lastToast().title, '已记上金额');
});

test('物品详情：归档之后仍然能打开（曾经会误报「找不到这个物品」）', async () => {
  const { stub, app, api } = setup();
  const list = await api.call('item', 'list');
  const paper = list.data.items.find((i) => i.name === '抽纸');
  await api.call('item', 'archive', { itemId: paper._id });

  const detail = mp.loadPage('pages/item-detail/item-detail', {
    wx: stub.wx,
    app,
    query: { id: paper._id }
  });
  await detail.onShow();
  await stub.flush();

  assert.ok(detail.data.card, '归档物品的详情页必须能打开');
  assert.equal(detail.data.card.name, '抽纸');
  assert.equal(detail.data.status, 'archived');
  assert.equal(detail.data.timeline.length, 3);
  assert.equal(
    stub.calls.toast.some((t) => /找不到/.test(t.title || '')),
    false,
    '不该弹「找不到这个物品」'
  );
});

test('物品详情：删除物品前必须确认', async () => {
  const { stub, app, api } = setup();
  const list = await api.call('item', 'list');
  const paper = list.data.items.find((i) => i.name === '抽纸');

  const detail = mp.loadPage('pages/item-detail/item-detail', {
    wx: stub.wx,
    app,
    query: { id: paper._id }
  });
  await detail.onShow();
  await stub.flush();

  // 先点取消，数据不能少
  stub.wx.__queueActionSheet({ tapIndex: 2 });
  stub.wx.__queueModal({ confirm: false });
  await detail.more();
  await stub.flush();
  assert.equal((await api.call('item', 'list')).data.items.length, 6, '取消后不该删');

  // 再确认删除
  stub.wx.__queueModal({ confirm: true });
  await detail.confirmRemove();
  await stub.flush();
  assert.equal((await api.call('item', 'list')).data.items.length, 5);
});

test('物品详情：归档后不在列表里，恢复后回来', async () => {
  const { stub, app, api } = setup();
  const list = await api.call('item', 'list');
  const paper = list.data.items.find((i) => i.name === '抽纸');

  const detail = mp.loadPage('pages/item-detail/item-detail', {
    wx: stub.wx,
    app,
    query: { id: paper._id }
  });
  await detail.onShow();
  await stub.flush();

  stub.wx.__queueActionSheet({ tapIndex: 1 });
  await detail.more();
  await stub.flush();
  assert.equal(detail.data.status, 'archived');
  assert.equal((await api.call('item', 'list')).data.items.length, 5);

  // 恢复
  await detail.onShow();
  await stub.flush();
  stub.wx.__queueActionSheet({ tapIndex: 1 });
  await detail.more();
  await stub.flush();
  assert.equal(detail.data.status, 'active');
  assert.equal((await api.call('item', 'list')).data.items.length, 6);
});

// ============================================================ 新建 / 编辑物品

test('新建物品：必填校验与保存成功后返回', async () => {
  const { stub, app, api } = setup();
  const edit = mp.loadPage('pages/item-edit/item-edit', { wx: stub.wx, app });

  assert.equal(edit.data.isCreate, true);
  await edit.save();
  assert.equal(stub.lastToast().title, '给物品起个名字');

  edit.onInput({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '保鲜膜' } });
  edit.onInput({ currentTarget: { dataset: { field: 'baseQty' } }, detail: { value: '2' } });
  edit.pickEstimate({ currentTarget: { dataset: { days: '30' } } });
  assert.match(edit.data.hint, /30 天用完/);

  await edit.save();
  await stub.flush();

  assert.equal(stub.lastToast().title, '已添加');
  const list = await api.call('item', 'list');
  assert.equal(list.data.items.length, 7);
  const created = list.data.items.find((i) => i.name === '保鲜膜');
  assert.equal(created.stock, 2);
  assert.equal(created.remainingDays, 30);
});

test('新建物品：重名会被拦下并给出可读提示', async () => {
  const { stub, app } = setup();
  const edit = mp.loadPage('pages/item-edit/item-edit', { wx: stub.wx, app });
  edit.onInput({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '抽纸' } });

  await edit.save();
  await stub.flush();

  assert.equal(stub.lastToast().title, '已经有一个叫「抽纸」的物品了');
});

test('编辑物品：回填现有值，且不提供改初始库存的入口', async () => {
  const { stub, app, api } = setup();
  const list = await api.call('item', 'list');
  const tooth = list.data.items.find((i) => i.name === '牙膏');

  const edit = mp.loadPage('pages/item-edit/item-edit', {
    wx: stub.wx,
    app,
    query: { id: tooth._id }
  });
  await stub.flush();

  assert.equal(edit.data.isCreate, false);
  assert.equal(edit.data.form.name, '牙膏');
  assert.equal(edit.data.form.brand, '云南白药');
  assert.equal(edit.data.categories[edit.data.categoryIndex], '洗护');

  edit.onInput({ currentTarget: { dataset: { field: 'spec' } }, detail: { value: '140g' } });
  await edit.save();
  await stub.flush();

  const after = (await api.call('item', 'list')).data.items.find((i) => i._id === tooth._id);
  assert.equal(after.spec, '140g');
  assert.equal(after.stock, tooth.stock, '改规格不能动库存');
});

// ============================================================ 统计页

test('统计页：展示本月金额、分类占比、预计月开销与趋势', async () => {
  const { stub, app } = setup();
  const stats = mp.loadPage('pages/stats/stats', { wx: stub.wx, app });
  await stats.onShow();
  await stub.flush();

  assert.equal(stats.data.loading, false);
  assert.equal(stats.data.months.length, 6);
  const view = stats.data.view;
  assert.ok(view, '统计视图不该为空');
  assert.equal(view.totalText, '89', '演示数据本月只有洗发水这一笔');
  assert.equal(view.countText, '1 笔');
  assert.equal(view.hasData, true);
  assert.ok(view.bars.length >= 1);
  assert.equal(view.trendBars.length, 6);
  assert.equal(view.trendBars[5].isCurrent, true);
  assert.ok(view.predicted.length >= 4, '大部分物品应该能估算月开销');
  assert.ok(Number(view.predictedTotalText) > 0);
  assert.match(view.predicted[0].monthlyQtyText, /每月约/);
});

test('统计页：切换月份会重新拉数据', async () => {
  const { stub, app } = setup();
  const stats = mp.loadPage('pages/stats/stats', { wx: stub.wx, app });
  await stats.onShow();
  await stub.flush();

  stats.onMonthChange({ detail: { value: 1 } });
  await stub.flush();
  assert.equal(stats.data.monthIndex, 1);
  assert.ok(stats.data.view);
});

test('统计页：点排行榜里的物品进详情', async () => {
  const { stub, app } = setup();
  const stats = mp.loadPage('pages/stats/stats', { wx: stub.wx, app });
  await stats.onShow();
  await stub.flush();

  stats.goItem({ currentTarget: { dataset: { id: 'it-paper' } } });
  assert.match(stub.calls.navigateTo[0].url, /item-detail\?id=it-paper/);
});

// ============================================================ 我的 / 家庭 / 设置

test('我的：显示家庭、额度与演示模式标记', async () => {
  const { stub, app } = setup();
  const me = mp.loadPage('pages/me/me', { wx: stub.wx, app });
  await me.onShow();
  await stub.flush();

  assert.equal(me.data.hasFamily, true);
  assert.equal(me.data.familyName, '我家');
  assert.equal(me.data.memberCount, 2);
  assert.equal(me.data.roleText, '创建者');
  assert.equal(me.data.quota, 2);
  assert.equal(me.data.isMock, true);
  assert.equal(me.data.envConfigured, false, '占位符环境下要提示未配置');
});

test('我的：导出数据会复制到剪贴板', async () => {
  const { stub, app } = setup();
  const me = mp.loadPage('pages/me/me', { wx: stub.wx, app });
  await me.onShow();
  await stub.flush();

  await me.exportData();
  await stub.flush();

  assert.equal(stub.calls.clipboard.length, 1);
  const parsed = JSON.parse(stub.calls.clipboard[0]);
  assert.equal(parsed.app, 'RefillPal');
  assert.equal(parsed.items.length, 6);
});

test('我的：重置演示数据会恢复初始状态', async () => {
  const { stub, app, api } = setup();
  const me = mp.loadPage('pages/me/me', { wx: stub.wx, app });
  await me.onShow();
  await stub.flush();
  await api.call('item', 'create', { name: '临时' });
  assert.equal((await api.call('item', 'list')).data.items.length, 7);

  stub.wx.__queueModal({ confirm: true });
  await me.resetDemo();
  await stub.flush();

  assert.equal((await api.call('item', 'list')).data.items.length, 6);
});

test('家庭页：显示邀请码与成员，可以复制邀请码', async () => {
  const { stub, app } = setup();
  const family = mp.loadPage('pages/family/family', { wx: stub.wx, app });
  await family.onShow();
  await stub.flush();

  assert.equal(family.data.isOwner, true);
  assert.equal(family.data.inviteCode, 'PAL123');
  assert.equal(family.data.members.length, 2);

  family.copyCode();
  assert.equal(stub.calls.clipboard[0], 'PAL123');
});

test('家庭页：邀请分享卡片带上邀请码', async () => {
  const { stub, app } = setup();
  const family = mp.loadPage('pages/family/family', { wx: stub.wx, app });
  await family.onShow();
  await stub.flush();

  const share = family.onShareAppMessage();
  assert.match(share.path, /inviteCode=PAL123/);
  assert.match(share.title, /我家/);
});

test('家庭页：退出家庭后会回到首页', async () => {
  const { stub, app } = setup();
  const family = mp.loadPage('pages/family/family', { wx: stub.wx, app });
  await family.onShow();
  await stub.flush();

  stub.wx.__queueModal({ confirm: true });
  await family.leave();
  await stub.flush();
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.equal(stub.calls.switchTab.length, 1);
  assert.equal(stub.calls.switchTab[0].url, '/pages/home/home');
});

test('设置页：加减提前天数、保存、时间格式', async () => {
  const { stub, app, api } = setup();
  const settings = mp.loadPage('pages/settings/settings', { wx: stub.wx, app });
  await settings.onShow();
  await stub.flush();

  assert.equal(settings.data.remindDays, 3);
  assert.equal(settings.data.changed, false);

  settings.changeDays({ currentTarget: { dataset: { delta: 1 } } });
  assert.equal(settings.data.remindDays, 4);
  assert.equal(settings.data.changed, true);

  settings.changeDays({ currentTarget: { dataset: { delta: -1 } } });
  settings.changeDays({ currentTarget: { dataset: { delta: -1 } } });
  assert.equal(settings.data.remindDays, 2);

  await settings.save();
  await stub.flush();
  assert.equal(stub.lastToast().title, '已保存');
  assert.equal(settings.data.changed, false);

  const profile = await api.call('family', 'profile');
  assert.equal(profile.data.family.settings.remindDays, 2);
});

test('设置页：提前天数不能超出 0-30', async () => {
  const { stub, app } = setup();
  const settings = mp.loadPage('pages/settings/settings', { wx: stub.wx, app });
  await settings.onShow();
  await stub.flush();

  for (let i = 0; i < 40; i += 1) settings.changeDays({ currentTarget: { dataset: { delta: 1 } } });
  assert.equal(settings.data.remindDays, 30);
  for (let i = 0; i < 40; i += 1) settings.changeDays({ currentTarget: { dataset: { delta: -1 } } });
  assert.equal(settings.data.remindDays, 0);
});

test('设置页：推送时间只能选整点（避免设了 9:30 却永远收不到）', async () => {
  const { stub, app, api } = setup();
  const settings = mp.loadPage('pages/settings/settings', { wx: stub.wx, app });
  await settings.onShow();
  await stub.flush();

  assert.equal(settings.data.hourOptions[0], '06:00');
  assert.equal(settings.data.hourOptions.indexOf('09:00'), settings.data.hourIndex);

  settings.onTimeChange({ detail: { value: 0 } });
  assert.equal(settings.data.pushTime, '06:00');

  await settings.save();
  await stub.flush();
  const profile = await api.call('family', 'profile');
  assert.equal(profile.data.family.settings.pushTime, '06:00');
});

test('设置页：可以预览真实会推送的内容，不用等到早上', async (t) => {
  t.after(withPush(true));
  const { stub, app } = setup();
  const settings = mp.loadPage('pages/settings/settings', { wx: stub.wx, app });
  await settings.onShow();
  await stub.flush();

  await settings.preview();
  await stub.flush();

  const modal = stub.lastModal();
  assert.equal(modal.title, '提醒内容预览');
  assert.match(modal.content, /thing1：/);
  assert.match(modal.content, /抽纸/);
  assert.match(modal.content, /待补货 2 样 \/ 共 6 样物品/);
  assert.match(modal.content, /还没有模板 ID/);
});

test('设置页：演示模式下续订额度', async (t) => {
  t.after(withPush(true));
  const { stub, app } = setup();
  const settings = mp.loadPage('pages/settings/settings', { wx: stub.wx, app });
  await settings.onShow();
  await stub.flush();
  await settings.renew();
  await stub.flush();
  assert.match(stub.lastToast().title, /已续订/);
  assert.equal(settings.data.quota, 5);
});

test('设置页：推送关闭时收起所有推送入口，并说明清单照常工作', async () => {
  const { stub, app } = setup();
  const settings = mp.loadPage('pages/settings/settings', { wx: stub.wx, app });
  await settings.onShow();
  await stub.flush();

  assert.equal(settings.data.pushFeatureOn, false);
  assert.equal(settings.data.remindDays, 3, '「提前几天提醒我」要留着，它决定首页清单的时机');

  // 关掉时这两个方法也得是空操作，不能偷偷去要授权
  await settings.renew();
  await settings.preview();
  await stub.flush();
  assert.equal(stub.calls.toast.length, 0);
  assert.equal(stub.calls.modal.length, 0);
});

test('【回归】续订时会把模板 ID 报给云端，否则 notify 永远发不出推送', async (t) => {
  t.after(withPush(true));
  const originalId = config.SUBSCRIBE_TEMPLATE_ID;
  config.SUBSCRIBE_TEMPLATE_ID = 'TPL-REAL-ID';
  t.after(() => {
    config.SUBSCRIBE_TEMPLATE_ID = originalId;
  });

  const { stub, app, api } = setup();
  const settings = mp.loadPage('pages/settings/settings', { wx: stub.wx, app });
  await settings.onShow();
  await stub.flush();
  await settings.renew();
  await stub.flush();

  // 云函数靠家庭设置里的 templateId 发消息，之前客户端没把 ID 传上去，
  // 导致真实部署后推送永远发不出去（演示模式看不出来）。
  const profile = await api.call('family', 'profile');
  assert.equal(profile.data.family.settings.templateId, 'TPL-REAL-ID');

  const preview = await api.call('notify', 'preview');
  assert.equal(preview.data.templateConfigured, true, '预览应该能看到模板已记录');
  assert.equal(preview.data.hasContent, true);
});

test('我的：推送总开关关闭时要能看到状态', async (t) => {
  const { stub, app } = setup();
  const me = mp.loadPage('pages/me/me', { wx: stub.wx, app });
  await me.onShow();
  await stub.flush();
  assert.equal(me.data.pushFeatureOn, false, 'WXML 靠它收起「提醒次数余额」那一行');

  t.after(withPush(true));
  await me.onShow();
  await stub.flush();
  assert.equal(me.data.pushFeatureOn, true, '打开后要恢复显示');
});

// ============================================================ 首次使用

test('首次使用：创建家庭成功后回到首页', async () => {
  const { stub, app, api } = setup();
  await api.call('family', 'leave');

  const onboarding = mp.loadPage('pages/onboarding/onboarding', { wx: stub.wx, app });
  assert.equal(onboarding.data.mode, 'create');
  assert.equal(onboarding.data.isMock, true);

  // 昵称不能为空
  onboarding.onInput({ currentTarget: { dataset: { field: 'nickName' } }, detail: { value: ' ' } });
  await onboarding.submit();
  assert.match(onboarding.data.error, /昵称/);

  onboarding.onInput({ currentTarget: { dataset: { field: 'nickName' } }, detail: { value: '爸爸' } });
  onboarding.onInput({ currentTarget: { dataset: { field: 'familyName' } }, detail: { value: '我们家' } });
  await onboarding.submit();
  await stub.flush();
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.equal(onboarding.data.error, '');
  const profile = await api.call('family', 'profile');
  assert.equal(profile.data.family.name, '我们家');
  assert.equal(profile.data.me.nickName, '爸爸');
});

test('首次使用：邀请码错误时把错误显示在页面上而不是弹 toast', async () => {
  const { stub, app, api } = setup();
  await api.call('family', 'leave');

  const onboarding = mp.loadPage('pages/onboarding/onboarding', { wx: stub.wx, app });
  onboarding.switchMode({ currentTarget: { dataset: { mode: 'join' } } });
  onboarding.onInput({ currentTarget: { dataset: { field: 'inviteCode' } }, detail: { value: 'WRONG1' } });
  await onboarding.submit();
  await stub.flush();

  assert.equal(onboarding.data.mode, 'join');
  assert.match(onboarding.data.error, /邀请码/);
});

test('首次使用：从分享链接带邀请码进入时自动切到「加入」', async () => {
  const { stub, app, api } = setup();
  await api.call('family', 'leave');

  const onboarding = mp.loadPage('pages/onboarding/onboarding', {
    wx: stub.wx,
    app,
    query: { inviteCode: 'pal123' }
  });
  assert.equal(onboarding.data.mode, 'join');
  assert.equal(onboarding.data.inviteCode, 'PAL123', '邀请码要自动大写');
});

// ============================================================ 组件

test('item-card：点击与长按把 id 抛给页面', () => {
  const { stub, app } = setup();
  const card = mp.loadPage('components/item-card/item-card', { wx: stub.wx, app });
  const events = [];
  card.triggerEvent = (name, detail) => events.push({ name, detail });
  card.data.card = { id: 'it-1', name: '抽纸', estimable: true, confidence: '较准' };

  card.onTap();
  card.onLongPress();

  assert.deepEqual(
    events.map((e) => e.name),
    ['tap', 'longpress']
  );
  assert.equal(events[0].detail.id, 'it-1');
});

test('empty-state：按钮触发 action 事件', () => {
  const { stub, app } = setup();
  const empty = mp.loadPage('components/empty-state/empty-state', { wx: stub.wx, app });
  const events = [];
  empty.triggerEvent = (name) => events.push(name);
  empty.onAction();
  assert.deepEqual(events, ['action']);
});

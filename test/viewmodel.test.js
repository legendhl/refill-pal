'use strict';

/**
 * 视图模型层测试。
 *
 * 这一层存在的全部理由就是「首页长什么样可以在 Node 里断言」，
 * 所以这里的断言必须具体到文案与数值，不能只测「不为空」。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const vm = require('../miniprogram/utils/viewmodel');
const core = require('../cloudfunctions/_shared/core');
const { day, makeItem, purchase, stocktake, usedUp } = require('../test-utils/fixtures');

const NOW = day('2026-09-25');

/** 基准点在「现在」的物品：fixtures 默认基准点是 2026-01-01，会让库存早被扣光 */
function itemNow(overrides = {}) {
  return makeItem(Object.assign({ baseAt: NOW }, overrides));
}

/** 用云端同一份算法造一个真实形态的视图 */
function viewFrom(item, events, now = NOW, options = { remindDays: 3 }) {
  return core.buildItemView(item, events, now, options);
}

// ---------------------------------------------------------------- 卡片文案

test('cardOf：已用完的物品显示为 overdue 并给出红色样式', () => {
  const item = makeItem({ name: '抽纸', unit: '包', baseAt: day('2026-08-01'), baseQty: 0 });
  // 8/1、8/21 各买 10 件 → 速率 0.5 件/天，到 9/25 早已用完
  const events = [
    purchase(item._id, 10, '2026-08-01'),
    purchase(item._id, 10, '2026-08-21')
  ];
  const view = viewFrom(item, events);
  const card = vm.cardOf(view, NOW);

  assert.equal(card.name, '抽纸');
  assert.equal(card.level, 'overdue');
  assert.equal(card.badge, '已用完');
  assert.equal(card.stockText, '已用完');
  assert.equal(card.color, '#E5484D');
  assert.equal(card.shortText, '已用完');
});

test('cardOf：还剩几天 → 显示「预计 N 天后用完」', () => {
  const item = itemNow({ name: '洗手液', unit: '瓶', baseQty: 2, initEstimateDays: 10 });
  const card = vm.cardOf(viewFrom(item, []), NOW);
  assert.equal(card.stockText, '还剩 2 瓶');
  assert.equal(card.remainingText, '预计 10 天后用完');
  assert.equal(card.level, 'ok');
});

test('cardOf：数据不足时如实说「还不够数据估算」，不假装精确', () => {
  const item = makeItem({ name: '洗发水', unit: '瓶', baseAt: day('2026-09-13'), baseQty: 1 });
  const view = viewFrom(item, [purchase(item._id, 1, '2026-09-13', { amount: 89 })]);
  const card = vm.cardOf(view, NOW);
  assert.equal(card.estimable, false);
  assert.equal(card.remainingText, '还不够数据估算');
  assert.equal(card.shortText, '待估算');
  assert.equal(card.confidence, '估算中');
  assert.equal(card.emptyAtText, '');
});

test('stockText：不足 1 个单位时说「不到 1 瓶」，而不是「还剩 0.1 瓶」', () => {
  const item = itemNow({ name: '洗手液', unit: '瓶', baseQty: 2, initEstimateDays: 45 });
  const view = viewFrom(item, []);
  assert.equal(view.stock, 2);
  // 手动构造一个不足 1 的库存
  const thin = Object.assign({}, view, { stock: 0.1 });
  assert.equal(vm.stockText(thin), '不到 1 瓶');
  assert.equal(vm.stockText(Object.assign({}, view, { stock: 1 })), '还剩 1 瓶');
});

test('cardOf：已用完时不再重复显示「已用完」', () => {
  const item = makeItem({ name: '抽纸', unit: '包', baseAt: day('2026-08-01'), baseQty: 0 });
  const events = [purchase(item._id, 10, '2026-08-01'), purchase(item._id, 10, '2026-08-21')];
  const card = vm.cardOf(viewFrom(item, events), NOW);
  assert.equal(card.stock <= 0, true);
  assert.equal(card.stockText, '已用完');
  assert.equal(card.showStock, false, '「已用完约 N 天 · 已用完」是废话，第二段要藏起来');

  const fine = vm.cardOf(viewFrom(itemNow({ name: '洗衣液', unit: '瓶', baseQty: 3, initEstimateDays: 30 })), NOW);
  assert.equal(fine.showStock, true, '还有货的时候要显示还剩多少');
});

test('stockText：新建但还没记过的物品不显示「已用完」', () => {
  const item = itemNow({ name: '新物品', baseQty: 0 });
  const card = vm.cardOf(viewFrom(item, []), NOW);
  assert.equal(card.stockText, '还没记过');
});

test('rateText：快慢两种表述都通顺', () => {
  const fast = itemNow({ name: '抽纸', unit: '包', baseQty: 2, initEstimateDays: 1 });
  assert.equal(vm.rateText(viewFrom(fast, [])), '每天约 2 包');

  const slow = itemNow({ name: '洗衣液', unit: '瓶', baseQty: 1, initEstimateDays: 10 });
  assert.equal(vm.rateText(viewFrom(slow, [])), '约 10 天用 1 瓶');

  const unknown = makeItem({ name: '洗发水', baseQty: 1 });
  assert.equal(vm.rateText(viewFrom(unknown, [])), '还不知道消耗速度');
});

test('basisText：把「这个数字怎么来的」讲清楚', () => {
  const init = itemNow({ baseQty: 2, initEstimateDays: 10 });
  assert.match(vm.basisText(viewFrom(init, [])), /按你填的/);

  const interval = makeItem({ baseAt: day('2026-01-01') });
  const events = [purchase(interval._id, 10, '2026-01-01'), purchase(interval._id, 10, '2026-01-31')];
  assert.match(vm.basisText(viewFrom(interval, events)), /补货间隔/);

  const unknown = makeItem({ baseQty: 1 });
  assert.match(vm.basisText(viewFrom(unknown, [])), /再记两次购买/);
});

test('basisText：盘点校准过的要单独说明（这是最准的一档）', () => {
  const item = makeItem({ baseAt: day('2026-01-01') });
  const events = [
    purchase(item._id, 10, '2026-01-01'),
    purchase(item._id, 10, '2026-01-11'),
    stocktake(item._id, 5, '2026-01-21'),
    usedUp(item._id, '2026-01-25'),
    stocktake(item._id, 10, '2026-02-01'),
    usedUp(item._id, '2026-02-11')
  ];
  const view = viewFrom(item, events, day('2026-02-11'));
  assert.equal(view.rateBasis, 'stocktake');
  assert.match(vm.basisText(view), /盘点校准过/);
});

test('emptyAtText：同年只显示月日，跨年带上年份', () => {
  const item = itemNow({ name: '抽纸', baseQty: 10, initEstimateDays: 10 });
  const view = viewFrom(item, []);
  assert.match(vm.emptyAtText(view, NOW), /^\d+ 月 \d+ 日$/);

  const longItem = itemNow({ name: '垃圾袋', baseQty: 10, initEstimateDays: 400 });
  const longView = viewFrom(longItem, []);
  assert.match(vm.emptyAtText(longView, NOW), /^\d{4} 年 \d+ 月 \d+ 日$/);
});

// ---------------------------------------------------------------- 首页头部

test('headline：一眼知道要不要出门', () => {
  assert.deepEqual(vm.headline(0, 0), { title: '暂时不用买', subtitle: '家里的东西都还够用' });
  const withOverdue = vm.headline(3, 1);
  assert.equal(withOverdue.title, '3 样该买了');
  assert.match(withOverdue.subtitle, /1 样已经用完/);
  const noOverdue = vm.headline(2, 0);
  assert.match(noOverdue.subtitle, /早点买/);
});

test('emptyRefillText：没有物品和「刚好不用买」要给不同引导', () => {
  assert.match(vm.emptyRefillText(0).title, /还没有物品/);
  assert.match(vm.emptyRefillText(0).desc, /物品.*页/);
  assert.match(vm.emptyRefillText(6).title, /不用买/);
});

// ---------------------------------------------------------------- 分组与搜索

test('groupByCategory：按预置分类顺序分组，组内按剩余天数升序', () => {
  const items = [
    itemNow({ name: '洗衣液', category: '清洁', baseQty: 5, initEstimateDays: 5 }),
    itemNow({ name: '抽纸', category: '纸品', baseQty: 1, initEstimateDays: 1 }),
    itemNow({ name: '卷纸', category: '纸品', baseQty: 3, initEstimateDays: 3 }),
    itemNow({ name: '没数据的东西', category: '其他', baseQty: 2 })
  ];
  const views = items.map((it) => viewFrom(it, []));
  const groups = vm.groupByCategory(views, NOW);

  assert.deepEqual(
    groups.map((g) => g.category),
    ['纸品', '清洁', '其他']
  );
  assert.deepEqual(
    groups[0].items.map((c) => c.name),
    ['抽纸', '卷纸']
  );
  // 无法估算的排在最后
  assert.deepEqual(
    groups[2].items.map((c) => c.name),
    ['没数据的东西']
  );
});

test('groupByCategory：自定义分类排在预置分类之后', () => {
  const items = [
    makeItem({ name: '猫粮', category: '宠物粮' }),
    makeItem({ name: '抽纸', category: '纸品' })
  ];
  const groups = vm.groupByCategory(items.map((it) => viewFrom(it, [])), NOW);
  assert.deepEqual(
    groups.map((g) => g.category),
    ['纸品', '宠物粮']
  );
});

test('filterByName：名称、分类、品牌、规格都能搜到', () => {
  const views = [
    viewFrom(makeItem({ name: '抽纸', category: '纸品', brand: '清风', spec: '3层120抽' })),
    viewFrom(makeItem({ name: '洗衣液', category: '清洁', brand: '威露士', spec: '2kg' }))
  ];
  assert.equal(vm.filterByName(views, '抽纸').length, 1);
  assert.equal(vm.filterByName(views, '清洁').length, 1);
  assert.equal(vm.filterByName(views, '清风').length, 1);
  assert.equal(vm.filterByName(views, '2kg').length, 1);
  assert.equal(vm.filterByName(views, '没这东西').length, 0);
  assert.equal(vm.filterByName(views, '  ').length, 2, '空关键词返回全部');
});

// ---------------------------------------------------------------- 时间轴

test('toTimeline：三类流水都有通顺的标题，且按时间倒序', () => {
  const item = makeItem({ name: '抽纸', unit: '包' });
  const events = [
    purchase(item._id, 2, '2026-09-01', { amount: 39.9, channel: '超市', spec: '3层120抽' }),
    stocktake(item._id, 4, '2026-09-10', { note: '数了一下' }),
    usedUp(item._id, '2026-09-20')
  ];
  const timeline = vm.toTimeline(events, item, NOW);

  assert.deepEqual(
    timeline.map((t) => t.title),
    ['用完了', '盘点：还剩 4 包', '买了 2 包']
  );
  assert.equal(timeline[2].subtitle, '超市 · 39.9 元 · 3层120抽');
  assert.equal(timeline[0].isClose, true);
  assert.equal(timeline[1].subtitle, '数了一下');
});

test('toTimeline：跨年的记录带上年份', () => {
  const item = makeItem({ name: '抽纸', unit: '包' });
  const timeline = vm.toTimeline([purchase(item._id, 1, '2025-03-05')], item, NOW);
  assert.match(timeline[0].dateText, /^2025 年 3 月 5 日$/);
});

// ---------------------------------------------------------------- 统计页

test('toStatsVm：金额、环比、占比、趋势柱都算对', () => {
  const stats = {
    month: '2026-09',
    current: {
      total: 100,
      count: 3,
      totalQty: 12,
      dailyAverage: 3.33,
      missingAmountCount: 1,
      byCategory: [
        { key: '纸品', amount: 60 },
        { key: '洗护', amount: 40 }
      ],
      byChannel: [{ key: '超市', amount: 100 }]
    },
    previous: { total: 50 },
    mom: 1,
    rank: [{ itemId: 'i1', name: '抽纸', category: '纸品', unit: '包', qty: 10, amount: 60, count: 2 }],
    trend: [
      { month: day('2026-04-01'), total: 0, count: 0 },
      { month: day('2026-05-01'), total: 50, count: 1 },
      { month: day('2026-06-01'), total: 20, count: 1 },
      { month: day('2026-07-01'), total: 0, count: 0 },
      { month: day('2026-08-01'), total: 50, count: 1 },
      { month: day('2026-09-01'), total: 100, count: 3 }
    ],
    predicted: [
      { itemId: 'i1', name: '抽纸', category: '纸品', unit: '包', monthlyQty: 10, monthlyCost: 40 },
      { itemId: 'i2', name: '未知价', category: '其他', unit: '个', monthlyQty: 3, monthlyCost: null }
    ],
    predictedTotal: 40,
    unestimableCount: 1
  };

  const v = vm.toStatsVm(stats);
  assert.equal(v.monthLabel, '2026 年 9 月');
  assert.equal(v.totalText, '100');
  assert.equal(v.countText, '3 笔');
  assert.equal(v.dailyText, '3.33 元');
  assert.deepEqual(v.mom, { text: '比上月多 100%', color: '#E5484D' });

  assert.deepEqual(v.bars, [
    { key: '纸品', amount: 60, amountText: '60 元', percent: 60 },
    { key: '洗护', amount: 40, amountText: '40 元', percent: 40 }
  ]);

  // 趋势柱按最大值归一化：100 → 100%，50 → 50%，0 → 至少 6%
  assert.deepEqual(
    v.trendBars.map((b) => b.heightPercent),
    [6, 50, 20, 6, 50, 100]
  );
  assert.equal(v.trendBars[5].isCurrent, true);
  assert.equal(v.trendBars[0].isCurrent, false);
  assert.equal(v.trendBars[1].label, '5 月');

  assert.equal(v.rank[0].qtyText, '10 包');
  assert.equal(v.rank[0].amountText, '60 元');
  assert.equal(v.predicted[0].monthlyCostText, '约 40 元');
  assert.equal(v.predicted[1].monthlyCostText, '没记过价格');
  assert.equal(v.predicted[1].hasCost, false);
  assert.equal(v.missingAmountCount, 1);
  assert.equal(v.unestimableCount, 1);
  assert.equal(v.hasData, true);
});

test('momText：下降用绿色、持平用灰色、无上月数据显示为空', () => {
  assert.deepEqual(vm.momText(-0.25), { text: '比上月少 25%', color: '#2E9E63' });
  assert.deepEqual(vm.momText(0), { text: '和上月持平', color: '#9A8C84' });
  assert.deepEqual(vm.momText(null), { text: '上个月没有记录', color: '#9A8C84' });
});

test('toStatsVm：一个空月份不能崩，也不该显示假数据', () => {
  const v = vm.toStatsVm({
    month: '2026-09',
    current: { total: 0, count: 0, byCategory: [], byChannel: [], missingAmountCount: 0, dailyAverage: 0, totalQty: 0 },
    previous: { total: 0 },
    mom: null,
    rank: [],
    trend: [],
    predicted: [],
    predictedTotal: 0
  });
  assert.equal(v.hasData, false);
  assert.equal(v.hasBars, false);
  assert.equal(v.totalText, '0');
  assert.deepEqual(v.trendBars, []);
});

test('toQuickItem：待补货的宫格项带高亮色', () => {
  const refill = viewFrom(itemNow({ name: '抽纸', unit: '包', baseQty: 0, initEstimateDays: 5 }));
  const fine = viewFrom(itemNow({ name: '洗发水', unit: '瓶', baseQty: 10, initEstimateDays: 100 }));
  assert.equal(vm.toQuickItem(refill).highlight, '#E5484D');
  assert.equal(vm.toQuickItem(fine).highlight, '');
});

test('posterLayout：清单海报写什么', () => {
  const cards = [
    { name: '抽纸', shortText: '已用完', color: '#E5484D' },
    { name: '洗手液', shortText: '2 天后', color: '#FF7A45' },
    { name: '洗衣液', shortText: '5 天后', color: '#D9A400' }
  ];
  const layout = vm.posterLayout(cards, { monthLabel: '2026 年 9 月', monthTotalText: '89' });
  assert.equal(layout.title, '3 样该买了');
  assert.equal(layout.subtitle, '2026 年 9 月已花 89 元');
  assert.deepEqual(
    layout.lines.map((l) => `${l.index}.${l.name}=${l.right}`),
    ['1.抽纸=已用完', '2.洗手液=2 天后', '3.洗衣液=5 天后']
  );
  assert.match(layout.footer, /补货小管家/);
});

test('posterLayout：超过 8 条时收口，避免海报长得离谱', () => {
  const cards = [];
  for (let i = 1; i <= 11; i += 1) cards.push({ name: `物品${i}`, shortText: `${i} 天后`, color: '#2F2723' });
  const layout = vm.posterLayout(cards, null);
  assert.equal(layout.title, '11 样该买了');
  assert.equal(layout.lines.length, 8);
  assert.equal(layout.moreCount, 3);
  assert.equal(layout.lines[7].name, '物品8');
});

test('posterLayout：没有待补货时也给一句人话，不留空', () => {
  const layout = vm.posterLayout([], null);
  assert.equal(layout.title, '暂时不用买');
  assert.equal(layout.subtitle, '家里的东西都还够用');
  assert.deepEqual(layout.lines, []);
});

test('normalizeItem：把云端下发的 ISO 字符串还原成日期', () => {
  const view = vm.normalizeItem({ _id: 'x', emptyAt: '2026-10-05T00:00:00.000Z', remainingDays: 10 });
  assert.ok(view.emptyAt instanceof Date);
  assert.equal(view.emptyAt.getTime(), new Date('2026-10-05T00:00:00.000Z').getTime());
});

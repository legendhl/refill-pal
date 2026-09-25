'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../cloudfunctions/_shared/core');
const { day, makeItem, purchase, stocktake, usedUp } = require('../test-utils/fixtures');

const NOW = day('2026-09-25');

// ============================================================ 基础统计工具

test('median：奇偶长度都正确', () => {
  assert.equal(core.median([3, 1, 2]), 2);
  assert.equal(core.median([4, 1, 3, 2]), 2.5);
  assert.equal(core.median([]), 0);
});

test('winsorize：样本 >= 3 时把离群值夹到中位数的 3 倍', () => {
  assert.deepEqual(core.winsorize([1, 1, 1, 1, 100]), [1, 1, 1, 1, 3]);
  // 样本不足 3 个时中位数不稳定，不做截断
  assert.deepEqual(core.winsorize([5, 5]), [5, 5]);
});

test('ewma：近期样本权重更大（alpha=0.6）', () => {
  // 0.6*5 + 0.4*1 = 3.4，比算术平均 3 更靠近新值 5
  assert.equal(core.ewma([1, 5]), 3.4);
  const mean = (1 + 5) / 2;
  assert.ok(core.ewma([1, 5]) > mean, 'EWMA 结果应比算术平均更靠近最新样本');
  assert.equal(core.ewma([]), null);
});

// ============================================================ 速率估算

test('estimateRate：只有冷启动估计时用它（已在家使用中的物品）', () => {
  const item = makeItem({ baseQty: 30, initEstimateDays: 30, rate: 0 });
  const est = core.estimateRate([], item);
  assert.equal(est.basis, 'init');
  assert.equal(est.rate, 1);
  assert.equal(est.closedCycles, 0);
});

test('estimateRate：冷启动 + 第一笔购买', () => {
  const item = makeItem({ initEstimateDays: 20, baseQty: 0 });
  const est = core.estimateRate([purchase(item._id, 10, '2026-01-01')], item);
  assert.equal(est.basis, 'init');
  // 10 件 / 20 天
  assert.equal(est.rate, 0.5);
});

test('estimateRate：补货间隔学习，且近期样本权重更大', () => {
  const item = makeItem({ anchorQty: 0 });
  const events = [
    purchase(item._id, 10, '2026-01-01'),
    purchase(item._id, 2, '2026-01-11'), // 样本 10/10 = 1.0
    purchase(item._id, 2, '2026-01-21') // 样本 2/10  = 0.2
  ];
  const est = core.estimateRate(events, item);
  assert.equal(est.basis, 'interval');
  assert.equal(est.closedCycles, 2);
  // 0.6*0.2 + 0.4*1.0 = 0.52
  assert.equal(est.rate, 0.52);
  assert.ok(est.rate < 0.6, '应比算术平均 0.6 更靠近近期样本 0.2');
});

test('estimateRate：同一天两笔（间隔 0）视为补录，丢弃', () => {
  const item = makeItem({ anchorQty: 0 });
  const events = [purchase(item._id, 5, '2026-01-01'), purchase(item._id, 5, '2026-01-01')];
  const est = core.estimateRate(events, item);
  assert.equal(est.detail.intervalSamples, 0);
  assert.equal(est.rate, null);
  assert.equal(est.basis, 'none');
});

test('estimateRate：盘点闭合样本参与融合（1 个盘点样本 → mixed）', () => {
  const item = makeItem({ anchorQty: 0 });
  const events = [
    purchase(item._id, 10, '2026-01-01'),
    purchase(item._id, 10, '2026-01-11'), // 间隔样本 10/10 = 1.0
    stocktake(item._id, 5, '2026-01-21'),
    usedUp(item._id, '2026-01-25') // 闭合：5 + 0 - 0 = 5，历时 4 天 → 1.25
  ];
  const est = core.estimateRate(events, item);
  assert.equal(est.detail.stocktakeSamples, 1);
  assert.equal(est.detail.intervalSamples, 1);
  assert.equal(est.basis, 'mixed');
  // 0.6*1.25 + 0.4*1.0 = 1.15
  assert.equal(est.rate, 1.15);
  assert.equal(est.closedCycles, 2);
});

test('estimateRate：盘点样本 >= 2 时以盘点为准', () => {
  const item = makeItem({ anchorQty: 0 });
  const events = [
    purchase(item._id, 10, '2026-01-01'),
    purchase(item._id, 10, '2026-01-11'),
    stocktake(item._id, 5, '2026-01-21'),
    usedUp(item._id, '2026-01-25'), // 1.25
    stocktake(item._id, 10, '2026-02-01'),
    usedUp(item._id, '2026-02-11') // 10/10 = 1.0
  ];
  const est = core.estimateRate(events, item);
  assert.equal(est.basis, 'stocktake');
  // 0.6*1.0 + 0.4*1.25 = 1.1
  assert.equal(est.rate, 1.1);
  assert.equal(est.detail.stocktakeSamples, 2);
});

test('estimateRate：盘点数据自相矛盾（剩余变多）时丢弃该样本', () => {
  const item = makeItem({ anchorQty: 0 });
  const events = [stocktake(item._id, 1, '2026-01-01'), stocktake(item._id, 5, '2026-01-11')];
  const est = core.estimateRate(events, item);
  assert.equal(est.detail.stocktakeSamples, 0);
  assert.equal(est.rate, null);
});

test('estimateRate：期间零消耗的盘点样本不产生正速率', () => {
  const item = makeItem({ anchorQty: 0 });
  const events = [stocktake(item._id, 5, '2026-01-01'), stocktake(item._id, 5, '2026-01-11')];
  const est = core.estimateRate(events, item);
  assert.equal(est.detail.stocktakeSamples, 0);
});

test('estimateRate：离群样本被截断，不会把速率带飞', () => {
  const item = makeItem({ anchorQty: 0 });
  const events = [
    purchase(item._id, 10, '2026-01-01'),
    purchase(item._id, 10, '2026-01-11'), // 1.0
    purchase(item._id, 10, '2026-01-21'), // 1.0
    purchase(item._id, 10, '2026-01-31'), // 1.0
    purchase(item._id, 1000, '2026-02-01') // 1000/1 = 1000，离群
  ];
  const est = core.estimateRate(events, item);
  assert.ok(est.rate > 1, '离群值仍应把速率往上带（近期权重）');
  assert.ok(est.rate < 10, `离群值不应把速率带飞，实际 ${est.rate}`);
});

test('estimateRate：事件乱序传入也能正确排序', () => {
  const item = makeItem({ anchorQty: 0 });
  const ordered = core.estimateRate(
    [
      purchase(item._id, 10, '2026-01-01'),
      purchase(item._id, 2, '2026-01-11'),
      purchase(item._id, 2, '2026-01-21')
    ],
    item
  );
  const shuffled = core.estimateRate(
    [
      purchase(item._id, 2, '2026-01-21'),
      purchase(item._id, 10, '2026-01-01'),
      purchase(item._id, 2, '2026-01-11')
    ],
    item
  );
  assert.equal(shuffled.rate, ordered.rate);
});

test('estimateRate：字符串日期（JSON 传输）也能解析', () => {
  const item = makeItem({ anchorQty: 0 });
  const events = [
    { itemId: item._id, type: 'purchase', qty: 10, occurredAt: '2026-01-01 00:00:00' },
    { itemId: item._id, type: 'purchase', qty: 10, occurredAt: '2026-01-11 00:00:00' }
  ];
  const est = core.estimateRate(events, item);
  assert.equal(est.rate, 1);
});

// ============================================================ 库存结算

test('settleStock：跨月按自然日扣减', () => {
  const item = makeItem({ anchorAt: day('2026-01-01'), anchorQty: 30 });
  // 1 月 1 日 → 2 月 1 日 = 31 天，30 - 0.5*31 = 14.5
  assert.equal(core.settleStock(item, day('2026-02-01'), 0.5), 14.5);
});

test('settleStock：库存不会被扣成负数', () => {
  const item = makeItem({ anchorAt: day('2026-01-01'), anchorQty: 1 });
  assert.equal(core.settleStock(item, day('2026-01-06'), 10), 0);
});

test('settleStock：锚点在未来或速率为 0 时返回锚点库存', () => {
  const item = makeItem({ anchorAt: day('2026-06-01'), anchorQty: 7 });
  assert.equal(core.settleStock(item, day('2026-01-01'), 1), 7);
  assert.equal(core.settleStock(item, day('2026-06-11'), 0), 7);
});

// ============================================================ 流水作用

test('applyEvent：购买先把库存结算到当天，再加上购买量', () => {
  const item = makeItem({ anchorAt: day('2026-01-01'), anchorQty: 10, rate: 1 });
  const { item: next, backdated } = core.applyEvent(
    item,
    purchase(item._id, 5, '2026-01-06'),
    day('2026-01-06')
  );
  assert.equal(backdated, false);
  assert.equal(next.anchorQty, 10); // 10 - 5*1 + 5
  assert.equal(core.toDate(next.anchorAt).getTime(), day('2026-01-06').getTime());
  assert.equal(core.toDate(next.lastPurchaseAt).getTime(), day('2026-01-06').getTime());
});

test('applyEvent：盘点直接覆盖库存，用完归零', () => {
  const item = makeItem({ anchorAt: day('2026-01-01'), anchorQty: 10, rate: 1 });
  assert.equal(core.applyEvent(item, stocktake(item._id, 7, '2026-01-02'), day('2026-01-02')).item.anchorQty, 7);
  assert.equal(core.applyEvent(item, usedUp(item._id, '2026-01-02'), day('2026-01-02')).item.anchorQty, 0);
});

test('applyEvent：补录历史流水时不把锚点挪回去（否则锚点后的流水会消失）', () => {
  const item = makeItem({ anchorAt: day('2026-01-11'), anchorQty: 10, rate: 0 });
  const { item: next, backdated } = core.applyEvent(
    item,
    purchase(item._id, 5, '2026-01-01'),
    day('2026-01-11')
  );
  assert.equal(backdated, true);
  assert.equal(core.toDate(next.anchorAt).getTime(), day('2026-01-11').getTime());
  assert.equal(next.anchorQty, 15);
});

test('applyEvent：不修改传入的 item（纯函数）', () => {
  const item = makeItem({ anchorAt: day('2026-01-01'), anchorQty: 10, rate: 1 });
  core.applyEvent(item, purchase(item._id, 5, '2026-01-06'), day('2026-01-06'));
  assert.equal(item.anchorQty, 10);
  assert.equal(core.toDate(item.anchorAt).getTime(), day('2026-01-01').getTime());
});

// ============================================================ 预测与分级

function itemWithStock(stock, rate = 1) {
  return makeItem({ anchorAt: NOW, anchorQty: stock, rate });
}

test('predict：宽松期 → ok，不触发补货', () => {
  const p = core.predict(itemWithStock(30), NOW, { remindDays: 3 });
  assert.equal(p.remainingDays, 30);
  assert.equal(p.level, 'ok');
  assert.equal(p.shouldRefill, false);
  assert.equal(core.daysBetween(NOW, p.emptyAt), 30);
});

test('predict：剩余天数恰好等于提前天数 → urgent（边界含等号）', () => {
  const p = core.predict(itemWithStock(3), NOW, { remindDays: 3 });
  assert.equal(p.remainingDays, 3);
  assert.equal(p.level, 'urgent');
  assert.equal(p.shouldRefill, true);
});

test('predict：3.1 天 → warn（快用完了，但还没到提醒线）', () => {
  const p = core.predict(itemWithStock(3.1), NOW, { remindDays: 3 });
  assert.equal(p.remainingDays, 3.1);
  assert.equal(p.level, 'warn');
  assert.equal(p.shouldRefill, false);
});

test('predict：2.9 天 → urgent', () => {
  const p = core.predict(itemWithStock(2.9), NOW, { remindDays: 3 });
  assert.equal(p.level, 'urgent');
  assert.equal(p.shouldRefill, true);
});

test('predict：库存为 0 → overdue，置顶提醒', () => {
  const p = core.predict(itemWithStock(0), NOW);
  assert.equal(p.stock, 0);
  assert.equal(p.remainingDays, 0);
  assert.equal(p.level, 'overdue');
  assert.equal(p.shouldRefill, true);
});

test('predict：没有速率（数据不足）时不打扰', () => {
  const p = core.predict(itemWithStock(5, 0), NOW);
  assert.equal(p.remainingDays, null);
  assert.equal(p.level, 'ok');
  assert.equal(p.shouldRefill, false);
  assert.equal(p.estimable, false);
});

test('predict：remindDays 可通过设置调整', () => {
  const item = itemWithStock(10);
  assert.equal(core.predict(item, NOW, { remindDays: 3 }).shouldRefill, false);
  assert.equal(core.predict(item, NOW, { remindDays: 14 }).shouldRefill, true);
});

// ============================================================ 列表构建

/** 构造一个「已解析好的视图」，用于单独测试排序逻辑 */
function viewOf(name, stock, rate = 1, overrides = {}) {
  const live = makeItem({ name, anchorAt: NOW, anchorQty: stock, rate, ...overrides });
  return { ...live, ...core.predict(live, NOW, { remindDays: 3 }) };
}

test('buildRefillList：已用完置顶，其余按剩余天数升序', () => {
  const views = [
    viewOf('洗发水', 10),
    viewOf('洗衣液', 2),
    viewOf('牙膏', 0),
    viewOf('抽纸', 1),
    viewOf('旧抹布', 0, 1, { status: 'archived' })
  ].filter((v) => v.status !== 'archived');

  const list = core.buildRefillList(views);
  assert.deepEqual(
    list.map((r) => r.name),
    ['牙膏', '抽纸', '洗衣液']
  );

  const ok = core.buildOkList(views);
  assert.deepEqual(
    ok.map((r) => r.name),
    ['洗发水']
  );
});

test('buildRefillList：无法估算的物品排在有估算的最后', () => {
  const unknown = viewOf('未知物', 5, 0);
  const known = viewOf('纸', 100, 1);
  const ok = core.buildOkList([unknown, known]);
  assert.deepEqual(
    ok.map((r) => r.name),
    ['纸', '未知物']
  );
});

// ============================================================ 事件溯源重放

test('resolveAll：库存由流水重放得出，不依赖写入时维护的累加值', () => {
  const item = makeItem({ name: '抽纸', baseAt: day('2026-01-01'), baseQty: 0 });
  const events = [
    purchase(item._id, 10, '2026-01-01'),
    purchase(item._id, 10, '2026-01-11'),
    purchase(item._id, 10, '2026-01-21')
  ];
  const [view] = core.resolveAll([item], { [item._id]: events }, day('2026-01-21'), { remindDays: 3 });
  assert.equal(view.rate, 1); // 10 件 / 10 天
  assert.equal(view.stock, 10); // 1 月 21 日刚买 10 件，当天未消耗
  assert.equal(view.remainingDays, 10);
  assert.equal(view.closedCycles, 2);
});

test('resolveAll：撤销最后一笔购买后，库存随之回退（这是事件溯源的意义）', () => {
  const item = makeItem({ name: '抽纸', baseAt: day('2026-01-01'), baseQty: 0 });
  const all = [
    purchase(item._id, 10, '2026-01-01'),
    purchase(item._id, 10, '2026-01-11'),
    purchase(item._id, 10, '2026-01-21')
  ];
  const [withLast] = core.resolveAll([item], { [item._id]: all }, day('2026-01-21'), {});
  const [withoutLast] = core.resolveAll([item], { [item._id]: all.slice(0, 2) }, day('2026-01-21'), {});
  assert.equal(withLast.stock, 10);
  // 只有前两笔时：1/11 买了 10，到 1/21 消耗 10 → 0
  assert.equal(withoutLast.stock, 0);
});

test('resolveAll：盘点覆盖之前的推算', () => {
  const item = makeItem({ baseAt: day('2026-01-01'), baseQty: 0 });
  const events = [
    purchase(item._id, 10, '2026-01-01'),
    purchase(item._id, 10, '2026-01-11'),
    purchase(item._id, 10, '2026-01-21'),
    stocktake(item._id, 3, '2026-01-25')
  ];
  const [view] = core.resolveAll([item], { [item._id]: events }, day('2026-01-25'), {});
  assert.equal(view.stock, 3);
});

test('resolveAll：基准点自带初始库存（把家里已有的东西加进来）', () => {
  const item = makeItem({ baseAt: day('2026-01-01'), baseQty: 30, initEstimateDays: 30 });
  const [view] = core.resolveAll([item], { [item._id]: [] }, day('2026-01-16'), { remindDays: 3 });
  assert.equal(view.rate, 1); // 冷启动：30 件 / 30 天
  assert.equal(view.stock, 15); // 过了 15 天
  assert.equal(view.confidence, '估算中');
  assert.equal(view.rateBasis, 'init');
});

test('replayEvents：补录历史流水会被标记，但不会让库存倒流', () => {
  const item = makeItem({ baseAt: day('2026-01-11'), baseQty: 10 });
  const live = core.replayEvents(item, [purchase(item._id, 5, '2026-01-01')], day('2026-01-11'), 0);
  assert.equal(live.backdatedCount, 1);
  assert.equal(live.anchorQty, 15);
  assert.equal(core.daysBetween(live.anchorAt, day('2026-01-11')), 0);
});

test('resolveAll：归档物品不出现在任何列表里', () => {
  const active = makeItem({ name: '在用', baseQty: 0 });
  const archived = makeItem({ name: '归档', status: 'archived', baseQty: 0 });
  const views = core.resolveAll([active, archived], {}, NOW, {});
  assert.equal(views.length, 1);
  assert.equal(views[0].name, '在用');
});

test('buildItemView：整合速率、置信度与预测', () => {
  const item = makeItem({ name: '抽纸', baseAt: day('2026-01-01'), baseQty: 0 });
  const events = [
    purchase(item._id, 10, '2026-01-01'),
    purchase(item._id, 10, '2026-01-11'),
    purchase(item._id, 10, '2026-01-21')
  ];
  const view = core.buildItemView(item, events, day('2026-01-21'), { remindDays: 3 });
  assert.equal(view.rate, 1);
  assert.equal(view.rateBasis, 'interval');
  assert.equal(view.closedCycles, 2);
  assert.equal(view.confidence, '粗略估计');
  // 1 月 21 日刚买的 10 件，速率 1 → 10 天
  assert.equal(view.stock, 10);
  assert.equal(view.remainingDays, 10);
});

test('confidenceLabel：三档文案', () => {
  assert.equal(core.confidenceLabel(0), '估算中');
  assert.equal(core.confidenceLabel(1), '粗略估计');
  assert.equal(core.confidenceLabel(2), '粗略估计');
  assert.equal(core.confidenceLabel(3), '较准');
});

// ============================================================ 月度统计

function statsFixture() {
  const paper = { _id: 'i-paper', name: '抽纸', category: '纸品' };
  const wash = { _id: 'i-wash', name: '洗手液', category: '洗护' };
  const clean = { _id: 'i-clean', name: '洗衣液', category: '清洁' };
  const itemsById = { 'i-paper': paper, 'i-wash': wash, 'i-clean': clean };
  const events = [
    purchase('i-paper', 2, '2026-09-05', { amount: 39.9, channel: '超市' }),
    purchase('i-wash', 1, '2026-09-15', { amount: 20 }),
    purchase('i-clean', 1, '2026-09-20', { amount: 50, channel: '京东' }),
    purchase('i-wash', 2, '2026-09-25', { amount: null }),
    purchase('i-paper', 2, '2026-08-05', { amount: 99 }) // 上月，不应计入
  ];
  return { itemsById, events };
}

test('summarizeMonthly：只统计当月，且按分类/渠道归集', () => {
  const { itemsById, events } = statsFixture();
  const s = core.summarizeMonthly(events, day('2026-09-01'), itemsById);
  assert.equal(s.count, 4);
  assert.equal(s.amountCount, 3);
  assert.equal(s.missingAmountCount, 1);
  assert.equal(s.total, 109.9);
  assert.deepEqual(s.byCategory, [
    { key: '清洁', amount: 50 },
    { key: '纸品', amount: 39.9 },
    { key: '洗护', amount: 20 }
  ]);
  assert.deepEqual(s.byChannel, [
    { key: '京东', amount: 50 },
    { key: '超市', amount: 39.9 },
    { key: '未记录', amount: 20 }
  ]);
  // 109.9 / 30 天
  assert.equal(s.dailyAverage, 3.66);
});

test('summarizeMonthly：分类缺失时归入「其他」', () => {
  const s = core.summarizeMonthly([purchase('i-unknown', 1, '2026-09-05', { amount: 9 })], day('2026-09-01'), {});
  assert.deepEqual(s.byCategory, [{ key: '其他', amount: 9 }]);
});

test('summarizeMonthly + previousMonth：环比计算', () => {
  const thisMonth = day('2026-09-01');
  assert.equal(core.daysBetween(core.previousMonth(thisMonth), thisMonth), 31);
  assert.equal(core.monthOverMonth(110, 100), 0.1);
  // 上月为 0 时无法计算环比，返回 null 而不是 ∞
  assert.equal(core.monthOverMonth(50, 0), null);
});

// ============================================================ 提醒文案

test('buildPushPayload：没有待补货时不推送', () => {
  const r = core.buildPushPayload({ name: '我家' }, [], NOW);
  assert.equal(r.hasContent, false);
  assert.equal(r.payload, null);
});

test('buildPushPayload：物品很多时截断，且不超过微信 thing 字段上限', () => {
  const views = ['抽纸', '洗手液', '洗衣液', '牙膏', '洗发水', '沐浴露', '洗洁精'].map((name) =>
    viewOf(name, 0)
  );
  const list = core.buildRefillList(views);
  assert.equal(list.length, 7);
  const { hasContent, payload } = core.buildPushPayload({ name: '我家' }, list, NOW);
  assert.equal(hasContent, true);
  assert.equal(payload.number3.value, 7);
  assert.ok(payload.thing1.value.length <= core.THING_MAX, `thing1 超长: ${payload.thing1.value}`);
  assert.ok(payload.thing1.value.endsWith('…'));
  assert.ok(payload.thing2.value.length <= core.THING_MAX);
  assert.equal(payload.time4.value, '2026-09-25 00:00');
});

test('buildPushPayload：最紧急的一条写进 thing2', () => {
  const list = core.buildRefillList([viewOf('抽纸', 2), viewOf('牙膏', 0)]);
  const { payload } = core.buildPushPayload({ name: '我家' }, list, NOW);
  assert.equal(payload.thing2.value, '牙膏已经用完了');
});

test('truncate：中文按字符计，超长补省略号', () => {
  assert.equal(core.truncate('短', 20), '短');
  const long = core.truncate('一二三四五六七八九十一二三四五六七八九十一二', 20);
  assert.equal(long.length, 20);
  assert.ok(long.endsWith('…'));
});

// ============================================================ 规格变更

test('detectSpecChange：混买不同规格时提示', () => {
  const item = makeItem();
  const same = core.detectSpecChange([
    purchase(item._id, 1, '2026-01-01', { brand: '清风', spec: '3层120抽' }),
    purchase(item._id, 1, '2026-02-01', { brand: '清风', spec: '3层120抽' })
  ]);
  assert.equal(same.changed, false);

  const mixed = core.detectSpecChange([
    purchase(item._id, 1, '2026-01-01', { brand: '清风', spec: '3层120抽' }),
    purchase(item._id, 1, '2026-02-01', { brand: '心相印', spec: '2层200抽' })
  ]);
  assert.equal(mixed.changed, true);
  assert.equal(mixed.specs.length, 2);
});

test('detectSpecChange：完全没记规格时不算变更', () => {
  const item = makeItem();
  const r = core.detectSpecChange([
    purchase(item._id, 1, '2026-01-01'),
    purchase(item._id, 1, '2026-02-01')
  ]);
  assert.equal(r.changed, false);
});

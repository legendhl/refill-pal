'use strict';

/**
 * 云函数集成测试：用内存伪数据库跑真实的 app.js 处理函数。
 *
 * 重点覆盖三件事：
 *   1. 归属安全：familyId 由 openid 反查，客户端伪造也读不到别人家的数据
 *   2. 家庭共享：成员 A 记的东西，成员 B 必须能看到
 *   3. 事件溯源：撤销之后库存要正确回退
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeDb, resetIdSeq } = require('../test-utils/fake-db');
const { day } = require('../test-utils/fixtures');

const familyApp = require('../cloudfunctions/family/app');
const itemApp = require('../cloudfunctions/item/app');
const purchaseApp = require('../cloudfunctions/purchase/app');
const dashboardApp = require('../cloudfunctions/dashboard/app');
const statsApp = require('../cloudfunctions/stats/app');

const NOW = day('2026-09-25');
const JAN = day('2026-01-01');

/** 构造一个「以某个 openid 身份调用」的客户端 */
function caller(db, openid, now = NOW) {
  const deps = { db, _: db.command, getOpenId: async () => openid, now: () => now };
  const wrap = (app) => (action, payload) => app.createApp(deps).handle({ action, payload });
  return {
    openid,
    family: wrap(familyApp),
    item: wrap(itemApp),
    purchase: wrap(purchaseApp),
    dashboard: wrap(dashboardApp),
    stats: wrap(statsApp)
  };
}

function newEnv(seed = {}) {
  resetIdSeq();
  const db = createFakeDb(seed);
  return { db, as: (openid, now) => caller(db, openid, now) };
}

/** 建一个两口之家 */
async function twoMemberFamily(env) {
  const dad = env.as('openid-dad');
  const created = await dad.family('create', { name: '我家', nickName: '爸爸' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const inviteCode = created.data.family.inviteCode;

  const mom = env.as('openid-mom');
  const joined = await mom.family('join', { inviteCode, nickName: '妈妈' });
  assert.equal(joined.ok, true, JSON.stringify(joined));

  return { dad, mom, familyId: created.data.family._id, inviteCode };
}

function ok(res) {
  assert.equal(res.ok, true, `期望成功，实际：${JSON.stringify(res)}`);
  return res.data;
}

function expectCode(res, code) {
  assert.equal(res.ok, false, `期望失败，实际：${JSON.stringify(res)}`);
  assert.equal(res.code, code, `期望错误码 ${code}，实际 ${res.code}：${res.message}`);
  return res;
}

// ============================================================ 家庭与归属

test('未加入家庭时 profile 返回空，dashboard 要求引导', async () => {
  const env = newEnv();
  const me = env.as('openid-new');
  const profile = ok(await me.family('profile'));
  assert.equal(profile.family, null);
  assert.deepEqual(profile.members, []);

  const home = ok(await me.dashboard('home'));
  assert.equal(home.needOnboarding, true);
});

test('创建家庭后成为 owner，邀请码可加入', async () => {
  const env = newEnv();
  const { dad, mom, familyId } = await twoMemberFamily(env);

  const dadProfile = ok(await dad.family('profile'));
  assert.equal(dadProfile.me.role, 'owner');
  assert.equal(dadProfile.family._id, familyId);
  assert.equal(dadProfile.members.length, 2);

  const momProfile = ok(await mom.family('profile'));
  assert.equal(momProfile.me.role, 'member');
  assert.equal(momProfile.family.name, '我家');
  // 不应该把别人的 openid 下发给客户端
  assert.equal(momProfile.members[0].openid, undefined);
});

test('邀请码错误时给出明确错误码，且不会把陌生人拉进家庭', async () => {
  const env = newEnv();
  await twoMemberFamily(env);

  const other = env.as('openid-other');
  expectCode(await other.family('join', { inviteCode: 'ZZZZZZ' }), 'INVALID_CODE');
  expectCode(await other.family('join', { inviteCode: '' }), 'INVALID_INPUT');

  const profile = ok(await other.family('profile'));
  assert.equal(profile.family, null);
  assert.equal(env.db._dump('members').length, 2, '不该产生多余成员');
});

test('已经在家庭里的人不能再创建或加入', async () => {
  const env = newEnv();
  const { dad, mom } = await twoMemberFamily(env);
  expectCode(await dad.family('create', { name: '另一个家' }), 'ALREADY_IN_FAMILY');
  expectCode(await mom.family('create', { name: '另一个家' }), 'ALREADY_IN_FAMILY');
});

test('【归属安全】客户端伪造 itemId 也读不到别人家的数据', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const created = ok(await dad.item('create', { name: '抽纸', unit: '包', baseQty: 2 }));
  const foreignItemId = created.item._id;

  // 另一个独立的家庭
  const stranger = env.as('openid-stranger');
  ok(await stranger.family('create', { name: '别人家' }));

  const list = ok(await stranger.item('list'));
  assert.equal(list.items.length, 0, '别人家的物品不该出现在我的列表里');

  expectCode(await stranger.item('detail', { itemId: foreignItemId }), 'ITEM_NOT_FOUND');
  expectCode(await stranger.item('update', { itemId: foreignItemId, patch: { name: '偷改' } }), 'ITEM_NOT_FOUND');
  expectCode(await stranger.item('archive', { itemId: foreignItemId }), 'ITEM_NOT_FOUND');
  expectCode(await stranger.item('remove', { itemId: foreignItemId }), 'ITEM_NOT_FOUND');
  expectCode(
    await stranger.purchase('add', { entries: [{ itemId: foreignItemId, qty: 1 }] }),
    'ITEM_NOT_FOUND'
  );

  // 原主人的数据没被动过
  const mine = ok(await dad.item('list'));
  assert.equal(mine.items.length, 1);
  assert.equal(mine.items[0].name, '抽纸');
});

test('【归属安全】撤销别人家的流水会被拒绝', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const created = ok(await dad.item('create', { name: '抽纸', unit: '包', baseQty: 0 }));
  const added = ok(await dad.purchase('add', { entries: [{ itemId: created.item._id, qty: 3 }] }));
  const foreignEventId = added.created[0];

  const stranger = env.as('openid-stranger');
  ok(await stranger.family('create', { name: '别人家' }));
  expectCode(await stranger.purchase('remove', { eventIds: [foreignEventId] }), 'EVENT_NOT_FOUND');
});

test('【家庭共享】成员 A 记的东西，成员 B 必须看得到', async () => {
  const env = newEnv();
  const { dad, mom } = await twoMemberFamily(env);

  const created = ok(await dad.item('create', { name: '抽纸', unit: '包', baseQty: 0 }));
  ok(await dad.purchase('add', { entries: [{ itemId: created.item._id, qty: 6, amount: 39.9, channel: '超市' }] }));

  const momList = ok(await mom.item('list'));
  assert.equal(momList.items.length, 1);
  assert.equal(momList.items[0].stock, 6);
  assert.equal(momList.items[0].name, '抽纸');

  const momHome = ok(await mom.dashboard('home'));
  assert.equal(momHome.summary.itemCount, 1);
  assert.equal(momHome.summary.monthTotal, 39.9);
});

test('成员管理：只有 owner 能移除成员，且不能移除自己', async () => {
  const env = newEnv();
  const { dad, mom } = await twoMemberFamily(env);

  const dadProfile = ok(await dad.family('profile'));
  const momMember = dadProfile.members.find((m) => m.role === 'member');
  const dadMember = dadProfile.members.find((m) => m.role === 'owner');

  expectCode(await mom.family('removeMember', { memberId: dadMember._id }), 'FORBIDDEN');
  expectCode(await dad.family('removeMember', { memberId: dadMember._id }), 'INVALID_INPUT');
  ok(await dad.family('removeMember', { memberId: momMember._id }));

  const after = ok(await dad.family('profile'));
  assert.equal(after.members.length, 1);
});

test('退出家庭：创建者退出时把创建者身份移交给最早加入的成员，数据保留', async () => {
  const env = newEnv();
  const { dad, mom } = await twoMemberFamily(env);
  ok(await dad.item('create', { name: '抽纸', unit: '包', baseQty: 1 }));

  const left = ok(await dad.family('leave'));
  assert.equal(left.left, true);
  assert.equal(left.keptData, true);

  const momProfile = ok(await mom.family('profile'));
  assert.equal(momProfile.me.role, 'owner', '创建者身份应移交给剩下的成员');
  // 数据没有丢
  const momList = ok(await mom.item('list'));
  assert.equal(momList.items.length, 1);

  // 退出的人不再属于任何家庭
  const dadProfile = ok(await dad.family('profile'));
  assert.equal(dadProfile.family, null);
});

test('提醒设置：校验格式，且设置真正影响待补货判定', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);

  const saved = ok(await dad.family('updateSettings', { remindDays: 7, pushTime: '08:30' }));
  assert.equal(saved.settings.remindDays, 7);
  assert.equal(saved.settings.pushTime, '08:30');

  expectCode(await dad.family('updateSettings', { remindDays: 99 }), 'INVALID_INPUT');
  expectCode(await dad.family('updateSettings', { pushTime: '8点' }), 'INVALID_INPUT');

  // 今天建、素材显示还能用 20 天的物品
  const created = ok(await dad.item('create', { name: '抽纸', unit: '包', baseQty: 20, initEstimateDays: 20 }));
  assert.equal(created.item.remainingDays, 20);

  let home = ok(await dad.dashboard('home'));
  assert.equal(home.remindDays, 7);
  assert.equal(home.refill.length, 0, '还剩 20 天，提前 7 天不该提醒');

  await dad.family('updateSettings', { remindDays: 25 });
  home = ok(await dad.dashboard('home'));
  assert.equal(home.remindDays, 25);
  assert.equal(home.refill.length, 1, '把提醒线提到 25 天后就该出现');
  assert.equal(home.ok.length, 0);
});

test('订阅额度：续订累加，推送后扣减', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const profile = ok(await dad.family('profile'));

  ok(await dad.family('subscribe', { count: 3 }));
  let after = ok(await dad.family('profile'));
  assert.equal(after.me.subQuota.remaining, 3);

  ok(await dad.family('markPushResult', { memberId: profile.me._id, consumed: 1 }));
  after = ok(await dad.family('profile'));
  assert.equal(after.me.subQuota.remaining, 2);
});

test('数据导出：返回可解析的 JSON 且包含物品与流水', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const created = ok(await dad.item('create', { name: '抽纸', unit: '包' }));
  ok(await dad.purchase('add', { entries: [{ itemId: created.item._id, qty: 2 }] }));

  const exported = ok(await dad.family('exportData'));
  assert.equal(exported.itemCount, 1);
  assert.equal(exported.eventCount, 1);
  const parsed = JSON.parse(exported.json);
  assert.equal(parsed.app, 'RefillPal');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.events[0].qty, 2);
});

// ============================================================ 物品

test('新建物品：必填校验 + 拒绝重名 + 初始库存进入基准点', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);

  expectCode(await dad.item('create', { name: '  ' }), 'INVALID_INPUT');
  expectCode(await dad.item('create', { name: '抽纸', unit: '包', baseQty: -1 }), 'INVALID_INPUT');

  const created = ok(await dad.item('create', { name: '抽纸', unit: '包', baseQty: 2, category: '纸品' }));
  assert.equal(created.item.stock, 2);
  assert.equal(created.item.name, '抽纸');

  expectCode(await dad.item('create', { name: '抽纸' }), 'DUPLICATE_NAME');
});

test('新建物品：填了「预计可用 N 天」时立刻有预测', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const created = ok(await dad.item('create', { name: '洗手液', baseQty: 2, initEstimateDays: 40 }));
  assert.equal(created.item.rate, 0.05);
  assert.equal(created.item.remainingDays, 40);
  assert.equal(created.item.rateBasis, 'init');
  assert.equal(created.item.confidence, '估算中');
});

test('修改物品：白名单之外的字段（含初始库存）改不动', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const created = ok(await dad.item('create', { name: '抽纸', baseQty: 5 }));

  const updated = ok(
    await dad.item('update', {
      itemId: created.item._id,
      patch: { name: '卷纸', category: '清洁', baseQty: 999, baseAt: day('2000-01-01'), familyId: 'hack' }
    })
  );
  assert.equal(updated.item.name, '卷纸');
  assert.equal(updated.item.category, '清洁');
  // 事件溯源的基准点不可被改写，库存必须还是 5
  assert.equal(updated.item.baseQty, 5);
  assert.equal(updated.item.stock, 5);
  assert.equal(updated.item.familyId, updated.item.familyId);

  const raw = env.db._dump('items')[0];
  assert.equal(raw.baseQty, 5);
  assert.equal(raw.baseAt.getTime(), NOW.getTime());
});

test('归档的物品不出现在列表与待补货里，可以恢复', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const created = ok(await dad.item('create', { name: '旧抹布', baseQty: 0 }));
  assert.equal(ok(await dad.item('list')).items.length, 1);

  ok(await dad.item('archive', { itemId: created.item._id }));
  assert.equal(ok(await dad.item('list')).items.length, 0);
  assert.equal(ok(await dad.dashboard('home')).refill.length, 0);

  ok(await dad.item('restore', { itemId: created.item._id }));
  assert.equal(ok(await dad.item('list')).items.length, 1);
});

test('盘点：正常校准库存', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const created = ok(await dad.item('create', { name: '抽纸', baseQty: 0 }));
  ok(await dad.purchase('add', { entries: [{ itemId: created.item._id, qty: 10 }] }));

  const res = ok(await dad.item('stocktake', { itemId: created.item._id, remaining: 4 }));
  assert.equal(res.item.stock, 4);
});

test('盘点：剩余量超过历史总量时要求二次确认，未确认不写入', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const created = ok(await dad.item('create', { name: '抽纸', baseQty: 0 }));
  ok(await dad.purchase('add', { entries: [{ itemId: created.item._id, qty: 10 }] }));

  const warn = ok(await dad.item('stocktake', { itemId: created.item._id, remaining: 99 }));
  assert.equal(warn.confirmNeeded, true);
  assert.match(warn.message, /99/);
  assert.equal(env.db._dump('events').length, 1, '未确认时不应该写入盘点');

  const forced = ok(await dad.item('stocktake', { itemId: created.item._id, remaining: 99, force: true }));
  assert.equal(forced.item.stock, 99);
  assert.equal(env.db._dump('events').length, 2);
});

test('用完：库存归零并进入待补货', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const created = ok(await dad.item('create', { name: '牙膏', baseQty: 3, initEstimateDays: 30 }));

  const res = ok(await dad.item('usedUp', { itemId: created.item._id }));
  assert.equal(res.item.stock, 0);
  assert.equal(res.item.level, 'overdue');

  const home = ok(await dad.dashboard('home'));
  assert.equal(home.refill.length, 1);
  assert.equal(home.refill[0].name, '牙膏');
});

test('归档物品不在列表里，但详情仍然能读（回归：曾误报 ITEM_NOT_FOUND）', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const created = ok(await dad.item('create', { name: '抽纸', baseQty: 2 }));
  ok(await dad.purchase('add', { entries: [{ itemId: created.item._id, qty: 3 }] }));

  ok(await dad.item('archive', { itemId: created.item._id }));
  assert.equal(ok(await dad.item('list')).items.length, 0, '归档后不该出现在列表里');

  const detail = ok(await dad.item('detail', { itemId: created.item._id }));
  assert.ok(detail.item, '详情必须仍然返回视图');
  assert.equal(detail.item.status, 'archived');
  assert.equal(detail.item.stock, 5);
  assert.equal(detail.events.length, 1);
});

test('物品详情：返回升序时间轴', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const created = ok(await dad.item('create', { name: '抽纸', baseQty: 0 }));
  ok(await dad.purchase('add', { entries: [{ itemId: created.item._id, qty: 1 }], occurredAt: day('2026-09-20') }));
  ok(await dad.purchase('add', { entries: [{ itemId: created.item._id, qty: 2 }], occurredAt: day('2026-09-10') }));

  const detail = ok(await dad.item('detail', { itemId: created.item._id }));
  assert.equal(detail.events.length, 2);
  assert.ok(
    new Date(detail.events[0].occurredAt) < new Date(detail.events[1].occurredAt),
    '时间轴应按发生时间升序'
  );
});

test('删除物品会连带删掉它的流水', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const created = ok(await dad.item('create', { name: '抽纸' }));
  ok(await dad.purchase('add', { entries: [{ itemId: created.item._id, qty: 1 }] }));
  assert.equal(env.db._dump('events').length, 1);

  ok(await dad.item('remove', { itemId: created.item._id }));
  assert.equal(env.db._dump('items').length, 0);
  assert.equal(env.db._dump('events').length, 0);
});

// ============================================================ 记一笔

test('记一笔：写入流水并回传更新后的视图', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const created = ok(await dad.item('create', { name: '抽纸', unit: '包' }));

  const res = ok(
    await dad.purchase('add', {
      entries: [{ itemId: created.item._id, qty: 3, amount: 39.9, channel: '超市', spec: '3层120抽' }]
    })
  );
  assert.equal(res.created.length, 1);
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].stock, 3);

  const raw = env.db._dump('events')[0];
  assert.equal(raw.type, 'purchase');
  assert.equal(raw.qty, 3);
  assert.equal(raw.amount, 39.9);
  assert.equal(raw.channel, '超市');
  assert.equal(raw.createdBy, 'openid-dad');
});

test('记一笔：金额填 0 等同于没填，避免污染统计', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const created = ok(await dad.item('create', { name: '抽纸' }));
  ok(await dad.purchase('add', { entries: [{ itemId: created.item._id, qty: 1, amount: 0 }] }));
  assert.equal(env.db._dump('events')[0].amount, null);
});

test('记一笔：数量与日期校验', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const created = ok(await dad.item('create', { name: '抽纸' }));

  expectCode(await dad.purchase('add', { entries: [] }), 'INVALID_INPUT');
  expectCode(await dad.purchase('add', { entries: [{ itemId: created.item._id, qty: 0 }] }), 'INVALID_INPUT');
  expectCode(await dad.purchase('add', { entries: [{ itemId: created.item._id, qty: -3 }] }), 'INVALID_INPUT');
  expectCode(
    await dad.purchase('add', { entries: [{ itemId: created.item._id, qty: 1 }], occurredAt: day('2026-12-31') }),
    'INVALID_INPUT'
  );
});

test('记一笔：可以补录过去的时间', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const created = ok(await dad.item('create', { name: '抽纸' }));
  ok(await dad.purchase('add', { entries: [{ itemId: created.item._id, qty: 1 }], occurredAt: day('2026-09-01') }));
  assert.equal(env.db._dump('events')[0].occurredAt.getTime(), day('2026-09-01').getTime());
});

test('【事件溯源】撤销一笔购买后库存回退，待补货随之更新', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const created = ok(await dad.item('create', { name: '抽纸', baseQty: 0, initEstimateDays: 10 }));
  const itemId = created.item._id;

  // 9/25 买 10 件
  const first = ok(await dad.purchase('add', { entries: [{ itemId, qty: 10 }] }));
  assert.equal(ok(await dad.item('list')).items[0].stock, 10);

  // 10/5 又买 10 件（此时距上次 10 天，速率学成 10 件/10 天）
  const later = day('2026-10-05');
  const october = env.as('openid-mom', later);
  const second = ok(await october.purchase('add', { entries: [{ itemId, qty: 10 }] }));

  const afterSecond = ok(await october.item('list'));
  assert.equal(afterSecond.items[0].rate, 1);
  assert.equal(afterSecond.items[0].stock, 10);
  assert.equal(afterSecond.items[0].remainingDays, 10);

  // 撤销第二笔后：只剩 9/25 买的 10 件，按 1 件/天算到 10/5 刚好用完
  const removed = ok(await october.purchase('remove', { eventIds: second.created }));
  assert.equal(removed.items[0].stock, 0);
  assert.equal(removed.items[0].level, 'overdue');
  assert.equal(removed.items[0].closedCycles, 0, '撤销后闭合周期也应回退');
  assert.equal(env.db._dump('events').length, first.created.length);
});

test('补录到基准点之前的购买会折叠进当前库存，不会被时间吞掉', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const created = ok(await dad.item('create', { name: '抽纸', baseQty: 0 }));

  // 物品今天才建，把购买日期填到今年 1 月
  ok(await dad.purchase('add', { entries: [{ itemId: created.item._id, qty: 3 }], occurredAt: JAN }));
  const list = ok(await dad.item('list'));
  assert.equal(list.items[0].stock, 3, '补录的量必须还在库存里');
  assert.equal(list.items[0].backdatedCount, 1, '要标记出这是补录，供界面提示');
});

test('常用物品排序：待补货优先，其次按购买次数', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const paper = ok(await dad.item('create', { name: '抽纸', baseQty: 0, initEstimateDays: 2 }));
  const soap = ok(await dad.item('create', { name: '洗手液', baseQty: 0, initEstimateDays: 500 }));

  ok(await dad.purchase('add', { entries: [{ itemId: paper.item._id, qty: 1 }] }));
  ok(await dad.purchase('add', { entries: [{ itemId: soap.item._id, qty: 1 }] }));
  ok(await dad.purchase('add', { entries: [{ itemId: soap.item._id, qty: 1 }] }));

  const frequent = ok(await dad.purchase('frequent', { limit: 10 }));
  assert.equal(frequent.items[0].name, '抽纸', '待补货的应排在最前面');
  assert.equal(frequent.items[0].purchaseCount, 1);
});

test('最近记录：带上物品名与单位', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const created = ok(await dad.item('create', { name: '抽纸', unit: '包' }));
  ok(await dad.purchase('add', { entries: [{ itemId: created.item._id, qty: 2 }] }));

  const recent = ok(await dad.purchase('recent', { limit: 5 }));
  assert.equal(recent.events.length, 1);
  assert.equal(recent.events[0].itemName, '抽纸');
  assert.equal(recent.events[0].unit, '包');
});

// ============================================================ 首页与统计

test('首页：一次返回待补货、还够用与本月亮概览', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const tight = ok(await dad.item('create', { name: '抽纸', baseQty: 1, initEstimateDays: 1, category: '纸品' }));
  const loose = ok(await dad.item('create', { name: '洗衣液', baseQty: 10, initEstimateDays: 100 }));
  ok(await dad.purchase('add', { entries: [{ itemId: tight.item._id, qty: 1, amount: 39.9, channel: '超市' }] }));

  const home = ok(await dad.dashboard('home'));
  assert.equal(home.needOnboarding, false);
  assert.equal(home.family.name, '我家');
  assert.equal(home.members.length, 2);
  assert.equal(home.summary.itemCount, 2);
  assert.equal(home.summary.refillCount, home.refill.length);
  assert.equal(home.summary.monthTotal, 39.9);
  assert.equal(home.summary.monthMissingAmount, 0);
  assert.deepEqual(
    home.refill.map((r) => r.name),
    ['抽纸']
  );
  assert.deepEqual(
    home.ok.map((r) => r.name),
    ['洗衣液']
  );
  assert.ok(home.serverTime, '必须带上服务端时间，客户端不自己算');
});

test('统计：月度开支、环比、排行、趋势与预计月开销', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const paper = ok(await dad.item('create', { name: '抽纸', category: '纸品', unit: '包' }));
  const soap = ok(await dad.item('create', { name: '洗手液', category: '洗护', unit: '瓶' }));

  // 用两笔购买建立速率与均价：抽纸 10 包 / 30 天 → 0.333/天，均价 4 元
  ok(await dad.purchase('add', { entries: [{ itemId: paper.item._id, qty: 10, amount: 40 }], occurredAt: day('2026-09-01') }));
  ok(await dad.purchase('add', { entries: [{ itemId: paper.item._id, qty: 10, amount: 40 }], occurredAt: day('2026-09-21') }));
  ok(await dad.purchase('add', { entries: [{ itemId: soap.item._id, qty: 1, amount: 20, channel: '京东' }], occurredAt: day('2026-09-22') }));
  // 上月一笔，用于环比
  ok(await dad.purchase('add', { entries: [{ itemId: soap.item._id, qty: 1, amount: 50 }], occurredAt: day('2026-08-15') }));

  const stats = ok(await dad.stats('monthly', { month: '2026-09' }));
  assert.equal(stats.month, '2026-09');
  assert.equal(stats.current.total, 100); // 40 + 40 + 20
  assert.equal(stats.previous.total, 50);
  assert.equal(stats.mom, 1); // (100-50)/50
  assert.equal(stats.trend.length, 6);
  assert.equal(stats.trend[5].total, 100);

  assert.deepEqual(
    stats.current.byCategory.map((c) => c.key),
    ['纸品', '洗护']
  );
  assert.equal(stats.rank[0].name, '抽纸');
  assert.equal(stats.rank[0].qty, 20);
  assert.equal(stats.rank[0].amount, 80);

  const predictedPaper = stats.predicted.find((p) => p.name === '抽纸');
  // 两次购买相隔 20 天、每次 10 件 → 速率 0.5 件/天 → 每月 15 件 × 均价 4 元 = 60 元
  assert.equal(predictedPaper.rate, 0.5);
  assert.equal(predictedPaper.unitPrice, 4);
  assert.equal(predictedPaper.monthlyQty, 15);
  assert.equal(predictedPaper.monthlyCost, 60);
});

test('统计：如实报告有多少笔没记金额', async () => {
  const env = newEnv();
  const { dad } = await twoMemberFamily(env);
  const paper = ok(await dad.item('create', { name: '抽纸' }));
  ok(await dad.purchase('add', { entries: [{ itemId: paper.item._id, qty: 1, amount: 10 }] }));
  ok(await dad.purchase('add', { entries: [{ itemId: paper.item._id, qty: 1 }] }));

  const stats = ok(await dad.stats('monthly', { month: '2026-09' }));
  assert.equal(stats.current.count, 2);
  assert.equal(stats.current.missingAmountCount, 1);
  assert.equal(stats.current.total, 10);
});

test('统计：没有加入家庭时给出 NO_FAMILY', async () => {
  const env = newEnv();
  const stranger = env.as('openid-nobody');
  expectCode(await stranger.stats('monthly', {}), 'NO_FAMILY');
});

test('未知 action 与缺少 openid 都有明确返回', async () => {
  const env = newEnv();
  const db = env.db;
  const deps = { db, _: db.command, getOpenId: async () => 'openid-x', now: () => NOW };
  const res = await familyApp.createApp(deps).handle({ action: 'notExist' });
  expectCode(res, 'UNKNOWN_ACTION');

  const noOpenid = await familyApp
    .createApp({ db, _: db.command, getOpenId: async () => null, now: () => NOW })
    .handle({ action: 'profile' });
  expectCode(noOpenid, 'NO_OPENID');
});

test('云函数内部异常不会把细节抛给客户端', async () => {
  const env = newEnv();
  const brokenDb = {
    collection() {
      throw new Error('内部数据库错误：连接串 xxx');
    }
  };
  const deps = { db: brokenDb, _: {}, getOpenId: async () => 'openid-x', now: () => NOW };
  const res = await familyApp.createApp(deps).handle({ action: 'profile' });
  expectCode(res, 'INTERNAL');
  assert.equal(/连接串/.test(res.message), false, '不应把内部错误细节暴露给用户');
});

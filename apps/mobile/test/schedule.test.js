'use strict';

/** 提醒排程：这是「本地通知」方案的核心逻辑，必须精确 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSchedule, atHour } = require('../src/notifications/schedule');

const NOW = new Date('2026-09-25T10:30:00+08:00');

function view(overrides) {
  return Object.assign(
    {
      _id: 'it-1',
      name: '抽纸',
      unit: '包',
      stock: 2,
      remainingDays: 5,
      emptyAt: new Date('2026-09-30T00:00:00+08:00').toISOString(),
      estimable: true
    },
    overrides
  );
}

test('按「预计用完日 - 提前天数」的当天 9 点排提醒', () => {
  const out = buildSchedule([view({})], { now: NOW, remindDays: 3, hour: 9 });

  assert.equal(out.length, 1);
  assert.equal(out[0].itemId, 'it-1');
  assert.equal(out[0].title, '该买抽纸了');
  assert.equal(out[0].body, '还剩 2 包');
  // 9/30 用完，提前 3 天 → 9/27 09:00
  assert.equal(atHour(out[0].date, 9).getTime(), new Date('2026-09-27T09:00:00+08:00').getTime());
});

test('已经用完的物品：排到下一个 9 点，并说明原因', () => {
  const out = buildSchedule([view({ stock: 0, remainingDays: 0 })], { now: NOW, hour: 9 });

  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'overdue');
  assert.equal(out[0].title, '抽纸已经用完了');
  assert.ok(out[0].date.getTime() > NOW.getTime());
  // 现在是 10:30，已经过了今天 9 点 → 排到明天 9 点
  assert.equal(out[0].date.getTime(), new Date('2026-09-26T09:00:00+08:00').getTime());
});

test('提醒点已过但还没用完：顺延到下一个 9 点，不会排到过去', () => {
  const out = buildSchedule([view({ emptyAt: new Date('2026-09-26T00:00:00+08:00').toISOString(), remainingDays: 1 })], {
    now: NOW,
    remindDays: 3,
    hour: 9
  });

  assert.equal(out.length, 1);
  assert.ok(out[0].date.getTime() > NOW.getTime(), '不能排到过去');
  assert.equal(out[0].date.getTime(), new Date('2026-09-26T09:00:00+08:00').getTime());
});

test('超出窗口（30 天）的不排', () => {
  const far = new Date('2026-12-31T00:00:00+08:00').toISOString();
  const out = buildSchedule([view({ emptyAt: far, remainingDays: 90 })], { now: NOW, horizonDays: 30 });
  assert.deepEqual(out, []);
});

test('估不出用完时间的物品不排（避免误报）', () => {
  const out = buildSchedule([view({ estimable: false, emptyAt: null, remainingDays: null })], { now: NOW });
  assert.deepEqual(out, []);
});

test('同一物品只排一条', () => {
  const out = buildSchedule([view({}), view({ _id: 'it-1' })], { now: NOW });
  assert.equal(out.length, 1);
});

test('多条按时间升序', () => {
  const out = buildSchedule(
    [
      view({ _id: 'b', name: '洗衣液', emptyAt: '2026-10-05T00:00:00+08:00' }),
      view({ _id: 'a', name: '抽纸', emptyAt: '2026-09-28T00:00:00+08:00' }),
      view({ _id: 'c', name: '垃圾袋', emptyAt: '2026-10-20T00:00:00+08:00' })
    ],
    { now: NOW, remindDays: 3 }
  );
  assert.deepEqual(
    out.map((s) => s.name || s.itemId),
    out.map((s) => s.itemId)
  );
  assert.equal(out[0].itemId, 'a');
  assert.equal(out[1].itemId, 'b');
  assert.equal(out[2].itemId, 'c');
});

test('提醒时间可配置（用户可以在设置里改）', () => {
  const out = buildSchedule([view({})], { now: NOW, remindDays: 3, hour: 21 });
  assert.equal(out[0].date.getHours(), 21);
});

test('提前 0 天 = 用完当天提醒', () => {
  const out = buildSchedule([view({ emptyAt: '2026-09-30T00:00:00+08:00' })], { now: NOW, remindDays: 0 });
  assert.equal(out[0].date.getTime(), new Date('2026-09-30T09:00:00+08:00').getTime());
});

test('数量小数显示成一位，不出现 0.1000000001 这类噪音', () => {
  const out = buildSchedule([view({ stock: 0.1 })], { now: NOW });
  assert.equal(out[0].body, '还剩 0.1 包');
});

test('空数组与脏数据不崩', () => {
  assert.deepEqual(buildSchedule([], { now: NOW }), []);
  assert.deepEqual(buildSchedule(null, { now: NOW }), []);
  assert.deepEqual(buildSchedule([null, undefined], { now: NOW }), []);
});

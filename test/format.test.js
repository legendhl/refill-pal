'use strict';

/** 客户端格式化与日期工具测试 */

const test = require('node:test');
const assert = require('node:assert/strict');

const format = require('../miniprogram/utils/format');

test('toDate：标准 ISO（带 Z）按 UTC 解析，不能按本地时间拆字符串', () => {
  const iso = '2026-10-05T00:00:00.000Z';
  assert.equal(format.toDate(iso).getTime(), Date.parse(iso));
});

test('toDate：带空格的日期字符串（iOS 不支持原生解析）要能解析', () => {
  assert.equal(format.toDate('2026-10-05 08:30:00').getTime(), new Date(2026, 9, 5, 8, 30, 0).getTime());
});

test('toDate：Date、时间戳、空值都安全', () => {
  const d = new Date(2026, 9, 5);
  assert.equal(format.toDate(d).getTime(), d.getTime());
  assert.equal(format.toDate(d.getTime()).getTime(), d.getTime());
  assert.ok(Number.isNaN(format.toDate(null).getTime()));
  assert.ok(Number.isNaN(format.toDate(undefined).getTime()));
  assert.ok(Number.isNaN(format.toDate('不是日期').getTime()));
});

test('toDate：云端返回的本地零点时刻，还原后仍是同一天', () => {
  // 本地 10 月 5 日零点，序列化成 UTC 会是 10 月 4 日 16:00Z
  const localMidnight = new Date(2026, 9, 5);
  const serialized = localMidnight.toISOString();
  const restored = format.toDate(serialized);
  assert.equal(restored.getFullYear(), 2026);
  assert.equal(restored.getMonth(), 9);
  assert.equal(restored.getDate(), 5, '不能因为时区偏移变成 10 月 4 日');
});

test('daysBetween：按自然日计算，跨月正确', () => {
  assert.equal(format.daysBetween(new Date(2026, 0, 1), new Date(2026, 1, 1)), 31);
  assert.equal(format.daysBetween(new Date(2026, 8, 25, 23, 59), new Date(2026, 8, 26, 0, 1)), 1);
  assert.equal(format.daysBetween(new Date(2026, 8, 25), new Date(2026, 8, 25, 23, 0)), 0);
});

test('remainingDaysText：天数、周、月三档，且 2 周以内不模糊化', () => {
  assert.equal(format.remainingDaysText(0), '已用完约 1 天');
  assert.equal(format.remainingDaysText(-3), '已用完约 3 天');
  assert.equal(format.remainingDaysText(0.5), '今天大概就用完了');
  assert.equal(format.remainingDaysText(1.2), '明天大概用完');
  assert.equal(format.remainingDaysText(2), '预计 2 天后用完');
  assert.equal(format.remainingDaysText(10), '预计 10 天后用完');
  assert.equal(format.remainingDaysText(13), '预计 13 天后用完');
  assert.equal(format.remainingDaysText(14), '预计 2 周后用完');
  assert.equal(format.remainingDaysText(30), '预计 4 周后用完');
  assert.equal(format.remainingDaysText(60), '预计 2 个月后用完');
  assert.equal(format.remainingDaysText(null), '还不够数据估算');
  assert.equal(format.remainingDaysText(undefined), '还不够数据估算');
});

test('shortRemainingText：卡片上的极短表述', () => {
  assert.equal(format.shortRemainingText(0), '已用完');
  assert.equal(format.shortRemainingText(0.5), '今天');
  assert.equal(format.shortRemainingText(1.2), '明天');
  assert.equal(format.shortRemainingText(5), '5 天后');
  assert.equal(format.shortRemainingText(45), '2 个月后');
  assert.equal(format.shortRemainingText(null), '待估算');
});

test('formatMoney：整数不显示小数，小数最多两位', () => {
  assert.equal(format.formatMoney(40), '40');
  assert.equal(format.formatMoney(39.9), '39.9');
  assert.equal(format.formatMoney(39.95), '39.95');
  assert.equal(format.formatMoney(39.904), '39.9', '多于两位要四舍五入并去掉尾随 0');
  assert.equal(format.formatMoney(0), '0');
  assert.equal(format.formatMoney(null), '0');
});

test('formatQty：数量去掉多余的小数位', () => {
  assert.equal(format.formatQty(2), '2');
  assert.equal(format.formatQty(1.5), '1.5');
  assert.equal(format.formatQty(1.0), '1');
});

test('formatDate / formatMonth：补零', () => {
  assert.equal(format.formatDate(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(format.formatDate(new Date(2026, 0, 5), '/'), '2026/01/05');
  assert.equal(format.formatMonth(new Date(2026, 8, 25)), '2026-09');
  assert.equal(format.formatDate('不是日期'), '');
});

test('startOfDay / addDays：跨月跨年', () => {
  assert.equal(format.formatDate(format.startOfDay(new Date(2026, 0, 31, 22, 30))), '2026-01-31');
  assert.equal(format.formatDate(format.addDays(new Date(2026, 0, 31), 1)), '2026-02-01');
  assert.equal(format.formatDate(format.addDays(new Date(2026, 11, 31), 1)), '2027-01-01');
  assert.equal(format.formatDate(format.addDays(new Date(2026, 0, 1), -1)), '2025-12-31');
});

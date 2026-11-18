'use strict';

/**
 * 提醒排程（纯函数，不碰 expo-notifications）。
 *
 * 这是「本地通知」方案的核心：App 每次启动或数据变化后，用它算出未来
 * 30 天该在什么时候提醒哪些物品，然后整批替换系统里的待定通知。
 *
 * 为什么不用远程推送：需求方确认只要「到点提醒我」。本地通知不需要
 * APNs / FCM / 国内厂商通道，iOS 与 Android 行为一致。
 */

const MS_DAY = 24 * 60 * 60 * 1000;

function startOfDay(date) {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

function atHour(date, hour) {
  const d = startOfDay(date);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (value === null || value === undefined) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 算出该排的本地通知。
 *
 * @param {Array} views       服务端下发的物品视图（含 name/unit/estimable/remainingDays/emptyAt/stock）
 * @param {object} options
 * @param {Date}   options.now            当前时间（注入，便于测试）
 * @param {number} [options.remindDays=3] 提前几天提醒
 * @param {number} [options.hour=9]       提醒时刻（本地时间）
 * @param {number} [options.horizonDays=30] 只排未来这么多天（iOS 待定通知上限 64 条）
 * @returns {Array<{id,itemId,title,body,date,kind}>}
 */
function buildSchedule(views, options = {}) {
  const now = toDate(options.now) || new Date();
  const remindDays = Number.isFinite(Number(options.remindDays)) ? Number(options.remindDays) : 3;
  const hour = Number.isFinite(Number(options.hour)) ? Number(options.hour) : 9;
  const horizonDays = Number.isFinite(Number(options.horizonDays)) ? Number(options.horizonDays) : 30;

  const horizonEnd = new Date(now.getTime() + horizonDays * MS_DAY);
  const seen = new Set();
  const out = [];

  (views || []).forEach((view) => {
    if (!view) return;
    if (seen.has(view._id)) return;

    const name = view.name || '物品';
    const unit = view.unit || '';
    const stock = Number(view.stock) || 0;
    const overdue = stock <= 0;

    let when;
    if (overdue) {
      // 已经用完 → 下一个 9 点提醒
      when = atHour(now, hour);
      if (when.getTime() <= now.getTime()) when = atHour(new Date(now.getTime() + MS_DAY), hour);
    } else {
      const emptyAt = toDate(view.emptyAt);
      if (!emptyAt) return; // 估不出时间的不排
      const target = new Date(emptyAt.getTime() - remindDays * MS_DAY);
      when = atHour(target, hour);
      if (when.getTime() <= now.getTime()) {
        // 已经过了提醒点但还没用完 → 下一个 9 点提醒
        when = atHour(now, hour);
        if (when.getTime() <= now.getTime()) when = atHour(new Date(now.getTime() + MS_DAY), hour);
      }
    }

    if (when.getTime() > horizonEnd.getTime()) return;

    seen.add(view._id);
    out.push({
      id: `${view._id}@${when.toISOString().slice(0, 10)}`,
      itemId: view._id,
      title: overdue ? `${name}已经用完了` : `该买${name}了`,
      body: overdue
        ? `记录里它已经用完了，记得补货`
        : `还剩 ${formatQty(view.stock)} ${unit}`.trim(),
      date: when,
      kind: overdue ? 'overdue' : 'upcoming'
    });
  });

  return out.sort((a, b) => a.date - b.date);
}

function formatQty(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0';
  if (Number.isInteger(num)) return String(num);
  return num.toFixed(1).replace(/\.0$/, '');
}

module.exports = { buildSchedule, atHour, startOfDay, MS_DAY };

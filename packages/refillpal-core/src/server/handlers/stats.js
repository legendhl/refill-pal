'use strict';

/**
 * stats 云函数：月度开支、分类/渠道占比、消耗速度排行、预计月开销、趋势。
 *
 * 「预计月开销」= 日均消耗 × 30 × 该物品的历史均价，
 * 回答的是「照这个用法，这些东西一个月要花多少钱」——
 * 这是仅靠记账本做不到、只有估算了消耗速度才能给出的数字。
 */

const kit = require('../kit');

/** 历史均价：itemId → 单件均价（只统计记了金额的购买） */
function averagePrices(events) {
  const acc = {};
  (events || []).forEach((e) => {
    if (e.type !== 'purchase' || e.amount === null || e.amount === undefined) return;
    const qty = Number(e.qty) || 0;
    if (qty <= 0) return;
    const key = String(e.itemId);
    if (!acc[key]) acc[key] = { amount: 0, qty: 0 };
    acc[key].amount += Number(e.amount);
    acc[key].qty += qty;
  });
  const out = {};
  Object.keys(acc).forEach((k) => {
    out[k] = acc[k].qty > 0 ? acc[k].amount / acc[k].qty : null;
  });
  return out;
}

const handlers = {
  async monthly(ctx) {
    const { db, openid, payload, now } = ctx;
    const { family } = await kit.requireFamily(db, openid);
    const core = kit.core;
    const month = kit.parseMonth(payload.month, now);
    const loaded = await kit.loadFamilyViews(db, family, now);
    const itemsById = kit.indexById(loaded.items);
    const events = loaded.events;

    const current = core.summarizeMonthly(events, month, itemsById);
    const previous = core.summarizeMonthly(events, core.previousMonth(month), itemsById);
    const mom = core.monthOverMonth(current.total, previous.total);
    const rank = core.summarizeByItem(events, month, itemsById);
    const trend = core.monthlyTrend(events, month, 6, itemsById);

    const prices = averagePrices(events);
    const predicted = loaded.views
      .filter((v) => v.rate > 0)
      .map((v) => {
        const price = prices[String(v._id)];
        return {
          itemId: String(v._id),
          name: v.name,
          category: v.category,
          unit: v.unit,
          rate: v.rate,
          monthlyQty: core.round(v.rate * 30, 2),
          unitPrice: price === null || price === undefined ? null : core.round(price, 2),
          monthlyCost: price === null || price === undefined ? null : core.round(v.rate * 30 * price, 2)
        };
      })
      .sort((a, b) => (b.monthlyCost || 0) - (a.monthlyCost || 0));

    const predictedTotal = core.round(
      predicted.reduce((s, p) => s + (p.monthlyCost || 0), 0),
      2
    );

    return {
      month: `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`,
      current,
      previous,
      mom,
      rank,
      trend,
      predicted,
      predictedTotal,
      /** 有多少物品还没法估算消耗（前端如实提示，不假装精确） */
      unestimableCount: loaded.views.filter((v) => !v.estimable).length,
      itemCount: loaded.views.length
    };
  }
};

module.exports = {
  handlers,
  averagePrices,
  createApp: (deps) => ({ handle: kit.createHandler(handlers, deps) })
};

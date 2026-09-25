'use strict';

/** 测试夹具：构造可读的日期、物品与流水 */

/** 'YYYY-MM-DD' → 本地时间当天零点 */
function day(str) {
  const [y, m, d] = String(str).split('-').map(Number);
  return new Date(y, m - 1, d);
}

let seq = 0;
function nextId(prefix) {
  seq += 1;
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}

function resetIds() {
  seq = 0;
}

function makeItem(overrides = {}) {
  return {
    _id: overrides._id || nextId('item'),
    familyId: 'fam-1',
    name: '抽纸',
    category: '纸品',
    unit: '包',
    brand: null,
    spec: null,
    initEstimateDays: null,
    rate: 0,
    // 存库的不可变基准点（事件溯源的起点）
    baseAt: day('2026-01-01'),
    baseQty: 0,
    // live item 的锚点（由 replayEvents / predict 使用）
    anchorAt: day('2026-01-01'),
    anchorQty: 0,
    lastPurchaseAt: null,
    status: 'active',
    createdAt: day('2026-01-01'),
    ...overrides
  };
}

function purchase(itemId, qty, date, extra = {}) {
  return {
    _id: extra._id || nextId('ev'),
    familyId: 'fam-1',
    itemId,
    type: 'purchase',
    qty,
    amount: extra.amount === undefined ? null : extra.amount,
    channel: extra.channel || null,
    brand: extra.brand || null,
    spec: extra.spec || null,
    note: extra.note || null,
    occurredAt: typeof date === 'string' ? day(date) : date,
    ...extra
  };
}

function stocktake(itemId, qty, date, extra = {}) {
  return {
    _id: extra._id || nextId('ev'),
    familyId: 'fam-1',
    itemId,
    type: 'stocktake',
    qty,
    amount: null,
    channel: null,
    occurredAt: typeof date === 'string' ? day(date) : date,
    ...extra
  };
}

function usedUp(itemId, date, extra = {}) {
  return {
    _id: extra._id || nextId('ev'),
    familyId: 'fam-1',
    itemId,
    type: 'used_up',
    qty: 0,
    amount: null,
    channel: null,
    occurredAt: typeof date === 'string' ? day(date) : date,
    ...extra
  };
}

module.exports = { day, makeItem, purchase, stocktake, usedUp, nextId, resetIds };

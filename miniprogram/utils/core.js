/* 由 scripts/sync-shared.js 自动生成，请勿直接修改。
 * 源文件：cloudfunctions/_shared/core.js
 * 小程序端仅 utils/mock.js（演示模式）使用；真实模式下库存一律由云端算好下发。
 */
'use strict';

/**
 * RefillPal 核心算法 —— 纯函数，无副作用，不依赖 wx-server-sdk、不依赖 wx API、不访问数据库。
 *
 * 本文件是**唯一事实来源**，由 scripts/sync-shared.js 复制到各云函数的 shared/core.js。
 * 小程序端不复制本文件：库存与预测一律由云端算好下发，客户端只做展示，
 * 避免客户端时间被篡改导致预测漂移。
 *
 * ── 库存模型：事件溯源 ──────────────────────────────────────────────
 * items 里只存不可变的**初始基准** baseAt / baseQty（创建物品时家里已有多少）。
 * 当前库存 = 用全部流水从基准点重放出来的结果，而不是写库时维护的累加值。
 * 这样做的好处：补录历史、撤销、删除流水、修正错误记录之后，
 * 库存永远和流水一致，不存在「缓存与事实不符」的状态。
 *
 * 两层数据结构：
 *   baseline item（存库）  { baseAt, baseQty, rate(缓存), ... }
 *   live item（算出来）    { anchorAt, anchorQty, rate, ... }
 * live item 由 replayEvents() 产出，predict() 只认 live item。
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** EWMA 平滑系数。取 0.6（>0.5）以保证「近期样本权重更大」这一可断言的特性。 */
const EWMA_ALPHA = 0.6;

/** 离群值截断倍数：样本数 >= 3 时，把样本夹到 [中位数/3, 中位数*3] */
const OUTLIER_RATIO = 3;

/** 两次事件间隔小于该天数视为「补录」，不参与速率学习 */
const MIN_SAMPLE_GAP_DAYS = 1;

/** 已用量出现负值（数据矛盾）时，样本作废 */
const MIN_CONSUMED_QTY = 0;

/** 订阅消息 thing 字段上限 20 个字符，超长会被微信拒绝 */
const THING_MAX = 20;

// ---------------------------------------------------------------- 日期工具

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const s = value.trim();
    // 标准 ISO（带 T，可能带 Z 或时区偏移）必须交给原生解析：
    // 带 Z 的是 UTC 时刻，自己拆字符串会整体偏移时区导致日期差一天。
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return new Date(s);
    // 'YYYY-MM-DD HH:mm:ss' 这种（iOS 不支持）换成斜杠格式再解析
    return new Date(s.replace(/-/g, '/'));
  }
  if (value && typeof value === 'object' && value.$date) return new Date(value.$date);
  return new Date(NaN);
}

function isValidDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

function startOfDay(value) {
  const d = toDate(value);
  if (!isValidDate(d)) return new Date(NaN);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 自然日差值：b - a */
function daysBetween(a, b) {
  const from = startOfDay(a);
  const to = startOfDay(b);
  if (!isValidDate(from) || !isValidDate(to)) return 0;
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

function addDays(value, n) {
  const d = startOfDay(value);
  d.setDate(d.getDate() + n);
  return d;
}

function round(x, digits = 3) {
  if (!Number.isFinite(x)) return 0;
  const f = Math.pow(10, digits);
  return Math.round(x * f) / f;
}

// ---------------------------------------------------------------- 统计工具

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 夹到 [median/RATIO, median*RATIO]。样本数 < 3 时中位数不稳定，原样返回。 */
function winsorize(values, ratio = OUTLIER_RATIO) {
  if (values.length < 3) return values.slice();
  const m = median(values);
  if (m <= 0) return values.slice();
  const lo = m / ratio;
  const hi = m * ratio;
  return values.map((v) => Math.min(hi, Math.max(lo, v)));
}

/** 指数加权平均，按时间顺序传入。空数组返回 null。 */
function ewma(values, alpha = EWMA_ALPHA) {
  if (!values.length) return null;
  let acc = values[0];
  for (let i = 1; i < values.length; i += 1) {
    acc = alpha * values[i] + (1 - alpha) * acc;
  }
  return acc;
}

// ---------------------------------------------------------------- 事件规整

const EVENT_TYPES = ['purchase', 'stocktake', 'used_up'];

function normalizeEvent(raw) {
  const src = raw || {};
  const type = EVENT_TYPES.indexOf(src.type) >= 0 ? src.type : 'purchase';
  const occurredAt = toDate(src.occurredAt || src.createdAt);
  return {
    id: src._id || src.id || null,
    itemId: src.itemId === undefined || src.itemId === null ? null : String(src.itemId),
    type,
    qty: Number(src.qty) || 0,
    amount: src.amount === undefined || src.amount === null ? null : Number(src.amount),
    channel: src.channel || null,
    brand: src.brand || null,
    spec: src.spec || null,
    note: src.note || null,
    occurredAt: isValidDate(occurredAt) ? occurredAt : new Date(0),
    backdated: Boolean(src.backdated)
  };
}

/** 按发生时间升序排列；同一天用 _id 兜底，保证结果可复现 */
function sortEvents(events) {
  return (events || [])
    .map(normalizeEvent)
    .sort((a, b) => {
      const diff = a.occurredAt.getTime() - b.occurredAt.getTime();
      if (diff !== 0) return diff;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
}

// ---------------------------------------------------------------- 速率估算

/**
 * 估算日均消耗速率。
 *
 * 三类证据，可靠性从低到高：
 *   1. 冷启动估计：用户首次添加物品时填的「大概能用 N 天」。只在没有任何观测数据时使用。
 *   2. 补货间隔：假设「每次补货时上一批基本用尽」，则 rate = 上一批数量 / 间隔天数。
 *      会被「提前囤货」干扰（囤货 → 间隔短 → 速率被高估）。
 *   3. 盘点闭合：两次盘点/用完之间，已用量 = 上次剩余 + 期间购买 - 本次剩余，
 *      精确且不受囤货干扰。
 *
 * 融合规则（刻意做成三段式而非加权求和，便于解释与测试）：
 *   - 盘点样本 >= 2  →  直接用盘点速率（权威）
 *   - 盘点样本 == 1  →  0.6 * 盘点速率 + 0.4 * 间隔速率
 *   - 无盘点样本     →  用间隔速率
 *   - 都没有         →  冷启动速率
 *   - 都没有         →  rate = null（无法估算，不打扰用户）
 */
function estimateRate(events, item = {}) {
  const list = sortEvents(events);
  const purchases = list.filter((e) => e.type === 'purchase');
  const closes = list.filter((e) => e.type === 'stocktake' || e.type === 'used_up');

  // --- 证据 2：补货间隔样本 ---
  const intervalSamples = [];
  for (let i = 1; i < purchases.length; i += 1) {
    const prev = purchases[i - 1];
    const cur = purchases[i];
    const gap = daysBetween(prev.occurredAt, cur.occurredAt);
    if (gap < MIN_SAMPLE_GAP_DAYS) continue; // 补录，丢弃
    if (!(prev.qty > 0)) continue;
    intervalSamples.push(prev.qty / gap);
  }

  // --- 证据 3：盘点闭合样本 ---
  const stocktakeSamples = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const cur = closes[i];
    const gap = daysBetween(prev.occurredAt, cur.occurredAt);
    if (gap < MIN_SAMPLE_GAP_DAYS) continue;
    const boughtInBetween = purchases
      .filter(
        (p) =>
          p.occurredAt.getTime() > prev.occurredAt.getTime() &&
          p.occurredAt.getTime() <= cur.occurredAt.getTime()
      )
      .reduce((sum, p) => sum + p.qty, 0);
    const consumed = prev.qty + boughtInBetween - cur.qty;
    if (consumed < MIN_CONSUMED_QTY) continue; // 数据自相矛盾，丢弃
    if (consumed === 0) continue; // 这段时间没消耗，不能用来算正速率
    stocktakeSamples.push(consumed / gap);
  }

  // --- 证据 1：冷启动 ---
  // 场景 A：新建物品时填了「大概能用 N 天」，随后记了第一笔购买
  // 场景 B：把家里已经在用的东西加进来（baseQty = 现在的存货 + 估计天数）
  let initRate = null;
  const initDays = Number(item.initEstimateDays);
  if (initDays > 0 && purchases.length > 0 && purchases[0].qty > 0) {
    initRate = purchases[0].qty / initDays;
  } else if (initDays > 0 && Number(item.baseQty) > 0) {
    initRate = Number(item.baseQty) / initDays;
  }

  const intervalRate = ewma(winsorize(intervalSamples));
  const stocktakeRate = ewma(winsorize(stocktakeSamples));

  let rate = null;
  let basis = 'none';
  if (stocktakeSamples.length >= 2) {
    rate = stocktakeRate;
    basis = 'stocktake';
  } else if (stocktakeSamples.length === 1) {
    rate = intervalRate === null ? stocktakeRate : 0.6 * stocktakeRate + 0.4 * intervalRate;
    basis = 'mixed';
  } else if (intervalSamples.length > 0) {
    rate = intervalRate;
    basis = 'interval';
  } else if (initRate !== null) {
    rate = initRate;
    basis = 'init';
  }

  if (rate !== null && (!Number.isFinite(rate) || rate <= 0)) {
    rate = null;
    basis = 'none';
  }

  return {
    rate: rate === null ? null : round(rate, 6),
    closedCycles: intervalSamples.length + stocktakeSamples.length,
    basis,
    detail: {
      intervalRate: intervalRate === null ? null : round(intervalRate, 6),
      stocktakeRate: stocktakeRate === null ? null : round(stocktakeRate, 6),
      initRate: initRate === null ? null : round(initRate, 6),
      intervalSamples: intervalSamples.length,
      stocktakeSamples: stocktakeSamples.length
    }
  };
}

/** 置信度文案：闭合周期数 → 人话 */
function confidenceLabel(closedCycles) {
  const n = Number(closedCycles) || 0;
  if (n <= 0) return '估算中';
  if (n < 3) return '粗略估计';
  return '较准';
}

// ---------------------------------------------------------------- 库存结算

/**
 * 锚点法结算：当前库存 = 锚点库存 - 速率 × 天数。
 * 不做逐日扣减，避免浮点误差累积、也避免速率变化时需要重放历史。
 * @param {{anchorAt: Date, anchorQty: number}} liveItem
 */
function settleStock(liveItem, now, rate) {
  const anchorQty = Number(liveItem.anchorQty) || 0;
  const anchorAt = toDate(liveItem.anchorAt);
  const r = Number.isFinite(rate) && rate > 0 ? rate : 0;
  if (!isValidDate(anchorAt)) return round(Math.max(0, anchorQty));
  const days = Math.max(0, daysBetween(anchorAt, now));
  return round(Math.max(0, anchorQty - r * days));
}

/**
 * 把一条流水作用到 live item 上，返回**新的** live item（不修改入参、不落库）。
 *
 * 锚点只向前推进：补录一条发生在锚点之前的历史记录时，不把锚点挪回去
 * （挪回去会让锚点之后已记录的流水凭空消失），而是折叠进当前锚点，
 * 并在返回值里标记 backdated 供上层提示。
 */
function applyEvent(liveItem, event, now) {
  const e = normalizeEvent(event);
  const anchorAt = toDate(liveItem.anchorAt);
  const at = isValidDate(anchorAt) && anchorAt.getTime() > e.occurredAt.getTime() ? anchorAt : e.occurredAt;
  const backdated = isValidDate(anchorAt) && e.occurredAt.getTime() < anchorAt.getTime();

  // 先把库存从「上一个锚点」结算到本条流水的发生时刻，再作用流水
  const settled = settleStock(liveItem, at, liveItem.rate);

  let anchorQty;
  switch (e.type) {
    case 'purchase':
      anchorQty = settled + e.qty;
      break;
    case 'stocktake':
      anchorQty = Math.max(0, e.qty);
      break;
    case 'used_up':
      anchorQty = 0;
      break;
    default:
      throw new Error(`未知的流水类型: ${e.type}`);
  }

  return {
    item: {
      ...liveItem,
      anchorAt: at,
      anchorQty: round(anchorQty),
      lastPurchaseAt: e.type === 'purchase' ? at : liveItem.lastPurchaseAt || null
    },
    backdated
  };
}

/** 物品的初始基准点（不可变）：创建时家里已有多少。保留传入的速率。 */
function baselineOf(item) {
  const baseAt = toDate(item.baseAt || item.createdAt);
  const rate = Number.isFinite(Number(item.rate)) && Number(item.rate) > 0 ? Number(item.rate) : 0;
  return {
    ...item,
    anchorAt: isValidDate(baseAt) ? baseAt : new Date(0),
    anchorQty: Math.max(0, Number(item.baseQty) || 0),
    rate,
    lastPurchaseAt: null
  };
}

/**
 * 用流水把基准点重放到 now，得到 live item。
 * 由于速率在区间内是常数，最终库存 = baseQty + Σ购买 - 速率 × 天数（盘点会重置基线）。
 */
function replayEvents(item, events, now, rate) {
  const list = sortEvents(events);
  let live = baselineOf({ ...item, rate: Number.isFinite(rate) && rate > 0 ? rate : 0 });
  let backdatedCount = 0;
  list.forEach((e) => {
    const res = applyEvent(live, e, now);
    live = res.item;
    if (res.backdated) backdatedCount += 1;
  });
  return { ...live, backdatedCount };
}

// ---------------------------------------------------------------- 预测

/**
 * 预测一个 live item 的库存与用完时间。
 * @param {object} liveItem 含 rate / anchorAt / anchorQty
 * @param {Date} now
 * @param {{remindDays?: number}} [options]
 */
function predict(liveItem, now, options = {}) {
  const remindDays = Number.isFinite(Number(options.remindDays))
    ? Number(options.remindDays)
    : 3;
  const rate =
    Number.isFinite(Number(liveItem.rate)) && Number(liveItem.rate) > 0 ? Number(liveItem.rate) : 0;
  const stock = settleStock(liveItem, now, rate);

  let remainingDays = null;
  if (rate > 0) {
    remainingDays = round(stock / rate, 2);
  } else if (stock <= 0) {
    remainingDays = 0;
  }

  let emptyAt = null;
  if (remainingDays !== null) {
    emptyAt = new Date(startOfDay(now).getTime() + remainingDays * MS_PER_DAY);
  }

  let level = 'ok';
  if (stock <= 0) {
    level = 'overdue';
  } else if (remainingDays === null) {
    level = 'ok'; // 无法估算就不打扰，只在物品页显示「还不够数据估算」
  } else if (remainingDays <= remindDays) {
    level = 'urgent';
  } else if (remainingDays <= remindDays * 2) {
    level = 'warn';
  }

  return {
    stock,
    rate,
    remainingDays,
    emptyAt,
    level,
    shouldRefill: stock <= 0 || (remainingDays !== null && remainingDays <= remindDays),
    estimable: rate > 0
  };
}

/**
 * 物品详情视图：把基准点 + 流水 + 速率 + 预测整合成一个扁平对象，直接下发前端。
 * 这是「读取路径」的唯一入口。
 */
function buildItemView(item, events, now, options = {}) {
  const est = estimateRate(events, item);
  const rate = est.rate === null ? 0 : est.rate;
  const live = replayEvents(item, events, now, rate);
  const p = predict(live, now, options);
  const specChange = detectSpecChange(events);

  return {
    ...item,
    ...live,
    ...p,
    rate,
    rateBasis: est.basis,
    rateDetail: est.detail,
    closedCycles: est.closedCycles,
    confidence: confidenceLabel(est.closedCycles),
    specChanged: specChange.changed,
    specList: specChange.specs,
    eventCount: (events || []).length,
    backdatedCount: live.backdatedCount
  };
}

/** 批量解析：items + 按 itemId 分组的流水 → 视图数组（已排除归档物品） */
function resolveAll(items, eventsByItem, now, options = {}) {
  const map = eventsByItem || {};
  return (items || [])
    .filter((it) => it && it.status !== 'archived')
    .map((it) => buildItemView(it, map[String(it._id)] || [], now, options));
}

/**
 * 待补货列表。输入是**已经解析好的视图**（含 shouldRefill / remainingDays / stock）。
 * 排序：已用完（逾期）置顶 → 剩余天数升序 → 名称，保证多次调用顺序稳定。
 */
function buildRefillList(views) {
  return (views || [])
    .filter((v) => v.shouldRefill)
    .sort((a, b) => {
      const aOverdue = a.stock <= 0 ? 0 : 1;
      const bOverdue = b.stock <= 0 ? 0 : 1;
      if (aOverdue !== bOverdue) return aOverdue - bOverdue;
      const ar = a.remainingDays === null ? Number.MAX_SAFE_INTEGER : a.remainingDays;
      const br = b.remainingDays === null ? Number.MAX_SAFE_INTEGER : b.remainingDays;
      if (ar !== br) return ar - br;
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
    });
}

/** 「还够用」列表：剩余天数升序，无法估算的排最后 */
function buildOkList(views) {
  return (views || [])
    .filter((v) => !v.shouldRefill)
    .sort((a, b) => {
      const ar = a.remainingDays === null ? Number.MAX_SAFE_INTEGER : a.remainingDays;
      const br = b.remainingDays === null ? Number.MAX_SAFE_INTEGER : b.remainingDays;
      if (ar !== br) return ar - br;
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
    });
}

// ---------------------------------------------------------------- 统计

function monthRange(monthStart) {
  const start = startOfDay(monthStart);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  return { start, end };
}

/**
 * 月度开支汇总。只有 purchase 类型的 amount 才计入金额。
 * @param {object} [itemsById] itemId → item，用于按分类归集
 */
function summarizeMonthly(events, monthStart, itemsById = {}) {
  const { start, end } = monthRange(monthStart);
  const inRange = (events || [])
    .map(normalizeEvent)
    .filter((e) => e.occurredAt.getTime() >= start.getTime() && e.occurredAt.getTime() < end.getTime());
  const purchases = inRange.filter((e) => e.type === 'purchase');

  const byCategoryMap = {};
  const byChannelMap = {};
  let total = 0;
  let totalQty = 0;
  let amountCount = 0;

  purchases.forEach((e) => {
    totalQty += e.qty;
    if (e.amount === null) return;
    amountCount += 1;
    total += e.amount;
    const item = itemsById[String(e.itemId)] || {};
    const cat = item.category || '其他';
    byCategoryMap[cat] = (byCategoryMap[cat] || 0) + e.amount;
    const ch = e.channel || '未记录';
    byChannelMap[ch] = (byChannelMap[ch] || 0) + e.amount;
  });

  const daysInMonth = daysBetween(start, end);
  const toSortedList = (map) =>
    Object.keys(map)
      .map((key) => ({ key, amount: round(map[key], 2) }))
      .sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key, 'zh'));

  return {
    month: start,
    start,
    end,
    total: round(total, 2),
    count: purchases.length,
    totalQty: round(totalQty, 2),
    amountCount,
    /** 有多少笔没记金额 —— 用于如实提示「统计不含未记金额的 N 笔」 */
    missingAmountCount: purchases.length - amountCount,
    byCategory: toSortedList(byCategoryMap),
    byChannel: toSortedList(byChannelMap),
    dailyAverage: round(total / daysInMonth, 2)
  };
}

function previousMonth(monthStart) {
  const start = startOfDay(monthStart);
  return new Date(start.getFullYear(), start.getMonth() - 1, 1);
}

/**
 * 按物品归集某月的购买（「消耗速度排行」用）。
 * 返回 [{itemId, name, category, unit, qty, amount, count}]，按金额降序。
 */
function summarizeByItem(events, monthStart, itemsById = {}) {
  const { start, end } = monthRange(monthStart);
  const map = {};
  (events || [])
    .map(normalizeEvent)
    .filter(
      (e) =>
        e.type === 'purchase' &&
        e.occurredAt.getTime() >= start.getTime() &&
        e.occurredAt.getTime() < end.getTime()
    )
    .forEach((e) => {
      const key = String(e.itemId);
      if (!map[key]) {
        const item = itemsById[key] || {};
        map[key] = {
          itemId: key,
          name: item.name || '未知物品',
          category: item.category || '其他',
          unit: item.unit || '',
          qty: 0,
          amount: 0,
          count: 0
        };
      }
      map[key].qty += e.qty;
      map[key].count += 1;
      if (e.amount !== null) map[key].amount += e.amount;
    });
  return Object.keys(map)
    .map((k) => {
      const row = map[k];
      return { ...row, qty: round(row.qty, 2), amount: round(row.amount, 2) };
    })
    .sort((a, b) => b.amount - a.amount || b.qty - a.qty || a.name.localeCompare(b.name, 'zh'));
}

/** 最近 N 个月的开支（统计页的趋势图）。返回按时间升序的 [{month, total, count}] */
function monthlyTrend(events, endMonth, count = 6, itemsById = {}) {
  const end = startOfDay(endMonth);
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const m = new Date(end.getFullYear(), end.getMonth() - i, 1);
    const s = summarizeMonthly(events, m, itemsById);
    out.push({ month: m, total: s.total, count: s.count, amountCount: s.amountCount });
  }
  return out;
}

/** 环比：(本月 - 上月) / 上月。上月为 0 时返回 null（无法计算，不显示 ∞） */
function monthOverMonth(current, previous) {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  if (p <= 0) return null;
  return round((c - p) / p, 4);
}

// ---------------------------------------------------------------- 提醒文案

function truncate(str, max = THING_MAX) {
  const s = String(str === undefined || str === null ? '' : str);
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * 构造每日汇总推送文案。
 * 微信订阅消息 thing 字段上限 20 字符，超出会被服务端拒绝，所以必须截断。
 * 字段名（thing1/thing2/number3/time4）需与你在小程序后台申请的模板一致，
 * 不一致时改这里并在 docs/deploy.md 里同步记录。
 */
function buildPushPayload(family, refillList, now) {
  const list = refillList || [];
  if (!list.length) {
    return { hasContent: false, payload: null };
  }
  const names = list.map((row) => row.name);
  const head = names.slice(0, 5).join('、');
  const more = names.length > 5 ? `等 ${names.length} 种` : '';
  const summary = truncate(`${head}${more}`, THING_MAX);
  const mostUrgent = list[0];
  const detail = truncate(
    mostUrgent.remainingDays !== null && mostUrgent.remainingDays <= 0
      ? `${mostUrgent.name}已经用完了`
      : `${mostUrgent.name}还能用 ${Math.max(1, Math.floor(mostUrgent.remainingDays || 0))} 天`,
    THING_MAX
  );

  return {
    hasContent: true,
    payload: {
      thing1: { value: summary },
      thing2: { value: detail },
      number3: { value: list.length },
      time4: { value: formatDateTimeForPush(now) }
    }
  };
}

function formatDateTimeForPush(value) {
  const d = toDate(value);
  const p = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------- 规格变更

/**
 * 检测「用同一物品名混买不同规格」。规格混买会让速率失真，
 * 上层据此提示用户盘点一次以校准。
 */
function detectSpecChange(events) {
  const purchases = sortEvents(events).filter((e) => e.type === 'purchase');
  const specs = [];
  purchases.forEach((e) => {
    const key = [e.brand || '', e.spec || ''].join('|');
    if (key === '|') return;
    if (specs.indexOf(key) < 0) specs.push(key);
  });
  return { changed: specs.length > 1, specs };
}

module.exports = {
  // 常量
  MS_PER_DAY,
  EWMA_ALPHA,
  OUTLIER_RATIO,
  MIN_SAMPLE_GAP_DAYS,
  EVENT_TYPES,
  THING_MAX,
  // 日期
  toDate,
  startOfDay,
  daysBetween,
  addDays,
  round,
  // 统计工具
  median,
  winsorize,
  ewma,
  // 事件
  normalizeEvent,
  sortEvents,
  // 估算
  estimateRate,
  confidenceLabel,
  settleStock,
  applyEvent,
  baselineOf,
  replayEvents,
  predict,
  buildItemView,
  resolveAll,
  buildRefillList,
  buildOkList,
  // 统计
  monthRange,
  summarizeMonthly,
  summarizeByItem,
  monthlyTrend,
  previousMonth,
  monthOverMonth,
  // 提醒
  buildPushPayload,
  truncate,
  formatDateTimeForPush,
  // 校验
  detectSpecChange
};

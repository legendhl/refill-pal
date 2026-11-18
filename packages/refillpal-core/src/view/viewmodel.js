/**
 * 视图模型层：把云端下发的数据加工成"界面要显示成什么样"。
 *
 * 为什么单独一层：所有排序、文案、颜色分级都在这里用纯函数实现，
 * 于是「首页长什么样」可以在 Node 里离线断言，不需要跑模拟器。
 * Page 里只允许做「取数据 → 调这里的函数 → setData」。
 */

const format = require('./format');
const { LEVELS, CATEGORIES } = require('./constants');

const DATE_FIELDS = ['baseAt', 'anchorAt', 'emptyAt', 'lastPurchaseAt', 'createdAt', 'updatedAt', 'occurredAt', 'joinedAt', 'serverTime'];

/** 云端把 Date 序列化成 ISO 字符串，这里还原成时间戳，供 format 使用 */
function normalizeItem(view) {
  if (!view) return view;
  const out = Object.assign({}, view);
  DATE_FIELDS.forEach((f) => {
    if (out[f] !== undefined && out[f] !== null && !(out[f] instanceof Date)) {
      const d = format.toDate(out[f]);
      out[f] = Number.isNaN(d.getTime()) ? null : d;
    }
  });
  return out;
}

function normalizeList(list) {
  return (list || []).map(normalizeItem);
}

// ---------------------------------------------------------------- 分级与文案

function levelStyle(level) {
  return LEVELS[level] || LEVELS.ok;
}

/** 库存文案：「还剩 3 包」「已用完」「还没记过」 */
function stockText(view) {
  const unit = (view && view.unit) || '';
  const qty = format.formatQty((view && view.stock) || 0);
  if (!view || (view.eventCount === 0 && !view.baseQty)) return '还没记过';
  if (view.stock <= 0) return '已用完';
  // 「还剩 0.1 瓶」对人没有意义，这种时候说「不到 1 瓶」更有用
  if (view.stock < 1) return `不到 1 ${unit}`.trim();
  return `还剩 ${qty} ${unit}`.trim();
}

/** 剩余天数文案，含「还不够数据估算」的如实表述 */
function remainingText(view) {
  if (!view) return '';
  if (!view.estimable && view.stock > 0) return '还不够数据估算';
  return format.remainingDaysText(view.remainingDays);
}

function shortRemainingText(view) {
  if (!view) return '';
  if (!view.estimable && view.stock > 0) return '待估算';
  return format.shortRemainingText(view.remainingDays);
}

/** 消耗速度的人话表述：「每天约 1.5 包」/「约 3 天 1 包」 */
function rateText(view) {
  if (!view || !view.estimable) return '还不知道消耗速度';
  const unit = view.unit || '';
  const rate = view.rate;
  if (rate >= 1) return `每天约 ${format.formatQty(rate)} ${unit}`.trim();
  const daysPerUnit = Math.round(1 / rate);
  return `约 ${daysPerUnit} 天用 1 ${unit}`.trim();
}

function confidenceText(view) {
  if (!view) return '';
  if (!view.estimable) return '估算中';
  return view.confidence || '估算中';
}

/** 告诉用户这个数字是怎么来的，建立信任 */
function basisText(view) {
  if (!view || !view.estimable) {
    return '再记两次购买，或者做一次「盘点」，它就能学会你的消耗速度。';
  }
  const map = {
    init: '按你填的「大概能用多久」估的，记几次购买后会自己修正。',
    interval: `根据最近 ${view.closedCycles} 次补货间隔算出来的。`,
    stocktake: `根据你之前的 ${view.closedCycles} 次盘点校准过，比较准。`,
    mixed: '结合了补货间隔和盘点记录。'
  };
  return map[view.rateBasis] || '根据历史购买记录估算。';
}

function emptyAtText(view, now = new Date()) {
  if (!view || !view.emptyAt || !view.estimable) return '';
  const d = format.toDate(view.emptyAt);
  if (!d || Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === format.toDate(now).getFullYear();
  const md = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return sameYear ? md : `${d.getFullYear()} 年 ${md}`;
}

// ---------------------------------------------------------------- 卡片

/** 首页「该买了」/「还够用」卡片 */
function cardOf(rawView, now = new Date()) {
  const view = normalizeItem(rawView);
  const style = levelStyle(view.level);
  return {
    id: String(view._id),
    name: view.name,
    category: view.category,
    unit: view.unit,
    spec: view.spec || '',
    brand: view.brand || '',
    stock: view.stock,
    stockText: stockText(view),
    // 已用完时 remainingText 已经说了「已用完约 N 天」，再显示一次「已用完」是废话
    showStock: view.stock > 0,
    remainingText: remainingText(view),
    shortText: shortRemainingText(view),
    emptyAtText: emptyAtText(view, now),
    rateText: rateText(view),
    confidence: confidenceText(view),
    estimable: Boolean(view.estimable),
    level: view.level,
    color: style.color,
    bg: style.bg,
    badge: style.label,
    specChanged: Boolean(view.specChanged)
  };
}

function toCards(views, now) {
  return (views || []).map((v) => cardOf(v, now));
}

/** 首页标题：一眼知道要不要出门 */
function headline(refillCount, overdueCount) {
  if (!refillCount) return { title: '暂时不用买', subtitle: '家里的东西都还够用' };
  if (overdueCount) {
    return {
      title: `${refillCount} 样该买了`,
      subtitle: `其中 ${overdueCount} 样已经用完了`
    };
  }
  return { title: `${refillCount} 样该买了`, subtitle: '趁着还没用完，早点买' };
}

/** 待补货为空时的解释文案（避免白屏让人困惑） */
function emptyRefillText(itemCount) {
  if (!itemCount) {
    return {
      emoji: '🧺',
      title: '还没有物品',
      desc: '先去「物品」页把家里常用的东西加进来，比如抽纸、洗手液。'
    };
  }
  return {
    emoji: '✅',
    title: '眼下不用买',
    desc: '记录得越多，它算得越准。东西用完了记得点一下「用完了」，下次就能提前提醒你。'
  };
}

// ---------------------------------------------------------------- 列表分组

/** 物品页：按分类分组，顺序沿用预置分类表 */
function groupByCategory(views, now = new Date()) {
  const map = new Map();
  (views || []).forEach((v) => {
    const key = v.category || '其他';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(v);
  });

  const order = (key) => {
    const idx = CATEGORIES.indexOf(key);
    return idx < 0 ? CATEGORIES.length : idx;
  };

  return Array.from(map.keys())
    .sort((a, b) => order(a) - order(b) || a.localeCompare(b, 'zh'))
    .map((category) => {
      const items = map.get(category).slice().sort((a, b) => {
        const ar = a.remainingDays === null || !a.estimable ? Number.MAX_SAFE_INTEGER : a.remainingDays;
        const br = b.remainingDays === null || !b.estimable ? Number.MAX_SAFE_INTEGER : b.remainingDays;
        if (ar !== br) return ar - br;
        return String(a.name).localeCompare(String(b.name), 'zh');
      });
      return {
        category,
        count: items.length,
        items: items.map((v) => cardOf(v, now))
      };
    });
}

/** 搜索过滤 */
function filterByName(views, keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return views || [];
  return (views || []).filter((v) => {
    const hay = [v.name, v.category, v.brand, v.spec].filter(Boolean).join(' ').toLowerCase();
    return hay.indexOf(kw) >= 0;
  });
}

// ---------------------------------------------------------------- 时间轴

function timelineTitle(event, item) {
  const unit = (item && item.unit) || '';
  const qty = format.formatQty(event.qty);
  if (event.type === 'purchase') return `买了 ${qty} ${unit}`.trim();
  if (event.type === 'stocktake') return `盘点：还剩 ${qty} ${unit}`.trim();
  return '用完了';
}

function timelineSubtitle(event) {
  const parts = [];
  if (event.channel) parts.push(event.channel);
  if (event.amount !== null && event.amount !== undefined) parts.push(`${format.formatMoney(event.amount)} 元`);
  if (event.spec) parts.push(event.spec);
  if (event.brand) parts.push(event.brand);
  if (event.note) parts.push(event.note);
  return parts.join(' · ');
}

function toTimeline(events, item, now = new Date()) {
  const thisYear = format.toDate(now).getFullYear();
  return (events || [])
    .map((raw) => {
      const event = normalizeItem(raw);
      const d = format.toDate(event.occurredAt);
      const sameYear = d.getFullYear() === thisYear;
      return {
        id: String(event._id),
        type: event.type,
        title: timelineTitle(event, item),
        subtitle: timelineSubtitle(event),
        dateText: sameYear
          ? `${d.getMonth() + 1} 月 ${d.getDate()} 日`
          : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`,
        isPurchase: event.type === 'purchase',
        isClose: event.type === 'used_up',
        occurredAt: event.occurredAt
      };
    })
    .sort((a, b) => format.toDate(b.occurredAt) - format.toDate(a.occurredAt));
}

// ---------------------------------------------------------------- 统计

function toBars(byCategory, total) {
  const sum = total || byCategory.reduce((s, c) => s + (c.amount || 0), 0);
  return (byCategory || []).map((c) => ({
    key: c.key,
    amount: c.amount,
    amountText: `${format.formatMoney(c.amount)} 元`,
    percent: sum > 0 ? Math.round((c.amount / sum) * 100) : 0
  }));
}

/** 趋势柱状图：高度按最大值归一化，最小留 6% 让空月份也看得见 */
function toTrendBars(trend) {
  const list = trend || [];
  const max = list.reduce((m, t) => Math.max(m, t.total || 0), 0);
  return list.map((t) => {
    const d = format.toDate(t.month);
    const ratio = max > 0 ? (t.total || 0) / max : 0;
    return {
      key: `${d.getFullYear()}-${d.getMonth() + 1}`,
      label: `${d.getMonth() + 1} 月`,
      total: t.total || 0,
      totalText: format.formatMoney(t.total || 0),
      heightPercent: Math.max(6, Math.round(ratio * 100)),
      isCurrent: false
    };
  });
}

function momText(mom) {
  if (mom === null || mom === undefined) return { text: '上个月没有记录', color: '#9A8C84' };
  const pct = Math.round(mom * 100);
  if (pct === 0) return { text: '和上月持平', color: '#9A8C84' };
  if (pct > 0) return { text: `比上月多 ${pct}%`, color: '#E5484D' };
  return { text: `比上月少 ${Math.abs(pct)}%`, color: '#2E9E63' };
}

/** 统计页完整视图模型 */
function toStatsVm(stats) {
  if (!stats) return null;
  const current = stats.current || {};
  const bars = toBars(current.byCategory, current.total);
  const trendBars = toTrendBars(stats.trend);
  if (trendBars.length) trendBars[trendBars.length - 1].isCurrent = true;

  const predicted = (stats.predicted || []).map((p) => ({
    itemId: p.itemId,
    name: p.name,
    category: p.category,
    unit: p.unit,
    monthlyQtyText: `每月约 ${format.formatQty(p.monthlyQty)} ${p.unit || ''}`.trim(),
    monthlyCostText: p.monthlyCost === null || p.monthlyCost === undefined ? '没记过价格' : `约 ${format.formatMoney(p.monthlyCost)} 元`,
    hasCost: p.monthlyCost !== null && p.monthlyCost !== undefined,
    monthlyCost: p.monthlyCost || 0
  }));

  return {
    monthLabel: (() => {
      const m = /^(\d{4})-(\d{2})$/.exec(stats.month || '');
      if (!m) return '';
      return `${m[1]} 年 ${Number(m[2])} 月`;
    })(),
    totalText: format.formatMoney(current.total || 0),
    countText: `${current.count || 0} 笔`,
    qtyText: format.formatQty(current.totalQty || 0),
    dailyText: `${format.formatMoney(current.dailyAverage || 0)} 元`,
    mom: momText(stats.mom),
    bars,
    trendBars,
    channelBars: toBars(current.byChannel, current.total),
    rank: (stats.rank || []).map((r) => ({
      itemId: r.itemId,
      name: r.name,
      category: r.category,
      qtyText: `${format.formatQty(r.qty)} ${r.unit || ''}`.trim(),
      amountText: r.amount > 0 ? `${format.formatMoney(r.amount)} 元` : '没记金额',
      countText: `${r.count} 笔`
    })),
    predicted,
    predictedTotalText: format.formatMoney(stats.predictedTotal || 0),
    unestimableCount: stats.unestimableCount || 0,
    missingAmountCount: current.missingAmountCount || 0,
    hasData: (current.count || 0) > 0,
    hasBars: bars.length > 0
  };
}

/**
 * 待补货清单海报的内容。
 * 只负责「写什么」，怎么画由页面负责 —— 于是这段逻辑可以离线断言。
 */
function posterLayout(cards, summary, maxLines = 8) {
  const list = cards || [];
  const shown = list.slice(0, maxLines);
  return {
    title: list.length ? `${list.length} 样该买了` : '暂时不用买',
    subtitle: summary ? `${summary.monthLabel}已花 ${summary.monthTotalText} 元` : '家里的东西都还够用',
    lines: shown.map((c, i) => ({
      index: i + 1,
      name: c.name,
      right: c.shortText || '',
      color: c.color || '#2F2723'
    })),
    /** 超过 maxLines 的部分不再逐个画，避免海报长得离谱 */
    moreCount: Math.max(0, list.length - shown.length),
    footer: '补货小管家 · 点开就能看到同一份清单'
  };
}

/** 「记一笔」宫格项 */
function toQuickItem(view) {
  const card = cardOf(view);
  return Object.assign(card, {
    purchaseCount: view.purchaseCount || 0,
    // 待补货的排前面时给个明显的视觉提示
    highlight: view.shouldRefill ? levelStyle(view.level).color : ''
  });
}

module.exports = {
  normalizeItem,
  normalizeList,
  levelStyle,
  stockText,
  remainingText,
  shortRemainingText,
  rateText,
  confidenceText,
  basisText,
  emptyAtText,
  cardOf,
  toCards,
  headline,
  emptyRefillText,
  groupByCategory,
  filterByName,
  toTimeline,
  toBars,
  toTrendBars,
  momText,
  toStatsVm,
  toQuickItem,
  posterLayout
};

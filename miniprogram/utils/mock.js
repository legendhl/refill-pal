/**
 * 演示模式（USE_MOCK = true）的数据层。
 *
 * 存在的意义有两个：
 *   1. 你还没开通云开发时，就能在开发者工具里把整个 UI 点一遍
 *   2. 我在没有云环境的情况下也能对页面逻辑做自动化验证
 *
 * 它和云端**共用同一份算法**（./core 由 scripts/sync-shared.js 从
 * cloudfunctions/_shared/core.js 复制过来），所以演示模式里的预测数字、
 * 排序、置信度与真实云端完全一致，不会出现「演示好看、上线变样」。
 *
 * 差别只在数据存哪：这里存本地 Storage，云端存云数据库。
 */

const core = require('./core');
const cache = require('./cache');

const STORAGE_KEY = 'mockState';

let state = null;
let latency = 120;
let storage = null;
let seededAt = null;

// ---------------------------------------------------------------- 存储适配

function defaultStorage() {
  return {
    get() {
      try {
        return wx.getStorageSync(cache.KEY_PREFIX + STORAGE_KEY) || null;
      } catch (e) {
        return null;
      }
    },
    set(value) {
      try {
        wx.setStorageSync(cache.KEY_PREFIX + STORAGE_KEY, value);
      } catch (e) {
        /* 演示模式存不下就算了 */
      }
    },
    clear() {
      try {
        wx.removeStorageSync(cache.KEY_PREFIX + STORAGE_KEY);
      } catch (e) {
        /* ignore */
      }
    }
  };
}

function persist() {
  if (storage) storage.set(JSON.parse(JSON.stringify(state)));
}

// ---------------------------------------------------------------- 演示数据

function daysAgo(n, base) {
  const d = new Date(base.getTime());
  d.setHours(9, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

/**
 * 造一份「用了一年」的演示数据。
 * 数值刻意设计成：1 样已用完、1 样还剩 2 天、1 样 5 天、1 样靠盘点校准过、
 * 1 样完全没数据 —— 把界面上所有状态都覆盖到。
 */
function seed(base = new Date()) {
  const familyId = 'fam-demo';
  const items = [
    { _id: 'it-paper', name: '抽纸', category: '纸品', unit: '包', brand: '清风', spec: '3层120抽' },
    { _id: 'it-soap', name: '洗手液', category: '洗护', unit: '瓶', brand: '蓝月亮', spec: '500ml' },
    { _id: 'it-laundry', name: '洗衣液', category: '清洁', unit: '瓶', brand: '威露士', spec: '2kg' },
    { _id: 'it-tooth', name: '牙膏', category: '洗护', unit: '支', brand: '云南白药', spec: '120g' },
    { _id: 'it-bag', name: '垃圾袋', category: '厨房', unit: '卷', brand: null, spec: '45×50' },
    { _id: 'it-shampoo', name: '洗发水', category: '洗护', unit: '瓶', brand: '海飞丝', spec: '750ml' }
  ].map((it) =>
    Object.assign(it, {
      familyId,
      initEstimateDays: null,
      baseAt: daysAgo(400, base),
      baseQty: 0,
      status: 'active',
      createdBy: 'openid-demo',
      createdAt: daysAgo(400, base),
      updatedAt: daysAgo(400, base)
    })
  );

  let seq = 0;
  function ev(itemId, type, qty, days, extra = {}) {
    seq += 1;
    return Object.assign(
      {
        _id: `ev-${String(seq).padStart(3, '0')}`,
        familyId,
        itemId,
        type,
        qty,
        amount: null,
        channel: null,
        brand: null,
        spec: null,
        note: null,
        occurredAt: daysAgo(days, base),
        createdBy: 'openid-demo',
        createdAt: daysAgo(days, base)
      },
      extra
    );
  }

  const events = [
    // 抽纸：30 天一提，已经用完了（含一次「用完」闭合信号 + 中途换过规格）
    ev('it-paper', 'purchase', 10, 65, { amount: 39.9, channel: '超市', spec: '3层120抽' }),
    ev('it-paper', 'purchase', 10, 35, { amount: 42, channel: '京东', spec: '4层100抽' }),
    ev('it-paper', 'used_up', 0, 33, {}),

    // 洗手液：45 天一轮，还剩 2 天
    ev('it-soap', 'purchase', 2, 88, { amount: 25.9, channel: '超市' }),
    ev('it-soap', 'purchase', 2, 43, { amount: 26.9, channel: '超市' }),

    // 洗衣液：60 天一轮，还剩 5 天
    ev('it-laundry', 'purchase', 1, 115, { amount: 49.9, channel: '京东' }),
    ev('it-laundry', 'purchase', 1, 55, { amount: 45, channel: '拼多多' }),

    // 牙膏：记过两次盘点，速率由盘点校准
    ev('it-tooth', 'purchase', 3, 168, { amount: 32.7, channel: '超市' }),
    ev('it-tooth', 'purchase', 3, 78, { amount: 35.4, channel: '超市' }),
    ev('it-tooth', 'stocktake', 2, 40, { note: '换新包装，重新数了一下' }),
    ev('it-tooth', 'stocktake', 1.5, 10, {}),

    // 垃圾袋：囤得多，用得慢
    ev('it-bag', 'purchase', 2, 210, { amount: 19.9, channel: '拼多多' }),
    ev('it-bag', 'purchase', 2, 90, { amount: 21.9, channel: '拼多多' }),

    // 洗发水：只记过一次，还估不出速度（故意放在今天，保证本月统计不为空）
    ev('it-shampoo', 'purchase', 1, 0, { amount: 89, channel: '京东' })
  ];

  return {
    family: {
      _id: familyId,
      name: '我家',
      inviteCode: 'PAL123',
      createdBy: 'openid-demo',
      createdAt: daysAgo(400, base),
      settings: { remindDays: 3, pushTime: '09:00', pushEnabled: true }
    },
    me: {
      _id: 'me-demo',
      familyId,
      nickName: '我',
      avatar: '',
      role: 'owner',
      joinedAt: daysAgo(400, base),
      subQuota: { remaining: 2, updatedAt: base }
    },
    members: [
      {
        _id: 'me-demo',
        familyId,
        nickName: '我',
        avatar: '',
        role: 'owner',
        joinedAt: daysAgo(400, base),
        subQuota: { remaining: 2, updatedAt: base }
      },
      {
        _id: 'me-mom',
        familyId,
        nickName: '妈妈',
        avatar: '',
        role: 'member',
        joinedAt: daysAgo(380, base),
        subQuota: { remaining: 0, updatedAt: base }
      }
    ],
    items,
    events,
    seededAt: base
  };
}

// ---------------------------------------------------------------- 内部工具

function now() {
  return new Date();
}

function settings() {
  return (state.family && state.family.settings) || { remindDays: 3, pushTime: '09:00', pushEnabled: true };
}

function eventsOf(itemId) {
  return state.events.filter((e) => String(e.itemId) === String(itemId));
}

function groupEvents() {
  const map = {};
  state.events.forEach((e) => {
    const key = String(e.itemId);
    if (!map[key]) map[key] = [];
    map[key].push(e);
  });
  return map;
}

function views() {
  return core.resolveAll(state.items, groupEvents(), now(), { remindDays: settings().remindDays });
}

/**
 * 单个物品的视图。刻意不走 views()（那里按列表口径排除归档物品），
 * 否则归档后进详情页会报「找不到这个物品」。
 */
function viewOf(itemId) {
  const item = findItem(itemId);
  if (!item) return null;
  return core.buildItemView(item, eventsOf(itemId), now(), { remindDays: settings().remindDays });
}

function findItem(itemId) {
  return state.items.find((it) => String(it._id) === String(itemId)) || null;
}

/** 与云端 toJSON 一致：Date → ISO 字符串 */
function respond(data) {
  return JSON.parse(JSON.stringify(data === undefined ? null : data));
}

function fail(code, message) {
  return { ok: false, code, message };
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
}

// ---------------------------------------------------------------- 动作实现

const handlers = {
  'family/profile': async () => ({
    family: state.family,
    me: state.me,
    members: state.members
  }),

  'family/create': async (payload) => {
    if (state.family) return fail('ALREADY_IN_FAMILY', '你已经在一个家庭里了（演示模式）');
    const family = {
      _id: nextId('fam'),
      name: (payload && payload.name) || '我家',
      inviteCode: 'DEMO01',
      createdBy: 'openid-demo',
      createdAt: now(),
      settings: { remindDays: 3, pushTime: '09:00', pushEnabled: true }
    };
    const me = {
      _id: nextId('me'),
      familyId: family._id,
      nickName: (payload && payload.nickName) || '我',
      avatar: '',
      role: 'owner',
      joinedAt: now(),
      subQuota: { remaining: 0, updatedAt: now() }
    };
    state.family = family;
    state.me = me;
    state.members = [me];
    return { family, me, members: state.members };
  },

  'family/join': async (payload) => {
    const code = String((payload && payload.inviteCode) || '').trim().toUpperCase();
    if (code !== 'PAL123' && code !== 'DEMO01') {
      return fail('INVALID_CODE', '邀请码不对（演示模式的邀请码是 PAL123）');
    }
    if (!state.family) {
      state.family = seed().family;
    }
    state.me = Object.assign({}, state.members[0], {
      _id: nextId('me'),
      role: 'member',
      nickName: (payload && payload.nickName) || '家人',
      joinedAt: now()
    });
    state.members = state.members.concat([state.me]);
    return { family: state.family, me: state.me, members: state.members };
  },

  'family/rename': async (payload) => {
    state.family.name = (payload && payload.name) || state.family.name;
    return { name: state.family.name };
  },

  'family/updateSettings': async (payload) => {
    const p = payload || {};
    if (p.remindDays !== undefined) {
      const n = Number(p.remindDays);
      if (!Number.isFinite(n) || n < 0 || n > 30) return fail('INVALID_INPUT', '提前天数应在 0-30 之间');
      state.family.settings.remindDays = n;
    }
    if (p.pushTime !== undefined) {
      if (!/^([01]\d|2[0-3]):00$/.test(String(p.pushTime))) {
        return fail('INVALID_INPUT', '推送时间只能选整点，例如 09:00');
      }
      state.family.settings.pushTime = String(p.pushTime);
    }
    if (p.pushEnabled !== undefined) state.family.settings.pushEnabled = Boolean(p.pushEnabled);
    return { settings: state.family.settings };
  },

  'family/subscribe': async (payload) => {
    const p = payload || {};
    const count = Number(p.count || 1);
    state.me.subQuota = {
      remaining: (state.me.subQuota.remaining || 0) + count,
      blocked: false,
      updatedAt: now()
    };
    const member = state.members.find((m) => m._id === state.me._id);
    if (member) member.subQuota = state.me.subQuota;
    if (p.templateId) state.family.settings.templateId = String(p.templateId);
    return { familyId: state.family._id, subQuota: state.me.subQuota, templateId: p.templateId || null };
  },

  'family/markPushResult': async (payload) => {
    const p = payload || {};
    const member = state.members.find((m) => m._id === p.memberId);
    if (!member) return { updated: 0 };
    member.subQuota = { remaining: Math.max(0, (member.subQuota.remaining || 0) - 1), updatedAt: now() };
    return { updated: 1, subQuota: member.subQuota };
  },

  'family/removeMember': async (payload) => {
    const id = payload && payload.memberId;
    if (id === state.me._id) return fail('INVALID_INPUT', '不能移除自己');
    if (state.me.role !== 'owner') return fail('FORBIDDEN', '只有创建者可以移除成员');
    state.members = state.members.filter((m) => m._id !== id);
    return { removed: id };
  },

  'family/leave': async () => {
    state.family = null;
    state.me = null;
    state.members = [];
    state.items = [];
    state.events = [];
    return { left: true, keptData: true };
  },

  'family/rotateInvite': async () => {
    state.family.inviteCode = nextId('PAL').slice(-6).toUpperCase();
    return { inviteCode: state.family.inviteCode };
  },

  'family/exportData': async () => {
    const payload = {
      app: 'RefillPal',
      version: 1,
      exportedAt: now(),
      family: state.family,
      items: state.items,
      events: state.events
    };
    return { json: JSON.stringify(payload), itemCount: state.items.length, eventCount: state.events.length };
  },

  'family/destroy': async () => {
    state.family = null;
    state.me = null;
    state.members = [];
    state.items = [];
    state.events = [];
    return { destroyed: true };
  },

  // ---------------- 物品

  'item/list': async () => ({
    items: views().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh')),
    remindDays: settings().remindDays
  }),

  'item/detail': async (payload) => {
    const item = findItem(payload && payload.itemId);
    if (!item) return fail('ITEM_NOT_FOUND', '找不到这个物品');
    return {
      item: viewOf(item._id),
      events: eventsOf(item._id).slice().sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt)),
      remindDays: settings().remindDays
    };
  },

  'item/create': async (payload) => {
    const p = payload || {};
    const name = String(p.name || '').trim();
    if (!name) return fail('INVALID_INPUT', '物品名不能为空');
    if (state.items.some((it) => it.name === name && it.status !== 'archived')) {
      return fail('DUPLICATE_NAME', `已经有一个叫「${name}」的物品了`);
    }
    const baseQty = Number(p.baseQty) || 0;
    if (baseQty < 0) return fail('INVALID_INPUT', '现有数量不能是负数');
    const item = {
      _id: nextId('it'),
      familyId: state.family._id,
      name,
      category: p.category || '其他',
      unit: p.unit || '个',
      brand: p.brand || null,
      spec: p.spec || null,
      initEstimateDays: p.initEstimateDays ? Number(p.initEstimateDays) : null,
      baseAt: now(),
      baseQty,
      status: 'active',
      createdBy: 'openid-demo',
      createdAt: now(),
      updatedAt: now()
    };
    state.items.push(item);
    return { item: viewOf(item._id) };
  },

  'item/update': async (payload) => {
    const p = payload || {};
    const item = findItem(p.itemId);
    if (!item) return fail('ITEM_NOT_FOUND', '找不到这个物品');
    const patch = p.patch || {};
    ['name', 'category', 'unit', 'brand', 'spec', 'initEstimateDays'].forEach((k) => {
      if (patch[k] !== undefined) item[k] = patch[k];
    });
    if (patch.initEstimateDays !== undefined) {
      item.initEstimateDays = patch.initEstimateDays ? Number(patch.initEstimateDays) : null;
    }
    item.updatedAt = now();
    return { item: viewOf(item._id) };
  },

  'item/archive': async (payload) => {
    const item = findItem(payload && payload.itemId);
    if (!item) return fail('ITEM_NOT_FOUND', '找不到这个物品');
    item.status = 'archived';
    return { archived: item._id };
  },

  'item/restore': async (payload) => {
    const item = findItem(payload && payload.itemId);
    if (!item) return fail('ITEM_NOT_FOUND', '找不到这个物品');
    item.status = 'active';
    return { item: viewOf(item._id) };
  },

  'item/remove': async (payload) => {
    const id = payload && payload.itemId;
    state.items = state.items.filter((it) => String(it._id) !== String(id));
    state.events = state.events.filter((e) => String(e.itemId) !== String(id));
    return { removed: id };
  },

  'item/stocktake': async (payload) => {
    const p = payload || {};
    const item = findItem(p.itemId);
    if (!item) return fail('ITEM_NOT_FOUND', '找不到这个物品');
    const remaining = Number(p.remaining);
    if (!Number.isFinite(remaining) || remaining < 0) return fail('INVALID_INPUT', '剩余数量不能是负数');

    if (!p.force) {
      const everOwned =
        (Number(item.baseQty) || 0) +
        eventsOf(item._id)
          .filter((e) => e.type === 'purchase')
          .reduce((s, e) => s + (Number(e.qty) || 0), 0);
      if (remaining > everOwned + 0.001) {
        return {
          confirmNeeded: true,
          message: `记录里这个物品一共只买过 ${everOwned} ${item.unit}，你填的是 ${remaining} ${item.unit}，确定没填错吗？`
        };
      }
    }

    const event = {
      _id: nextId('ev'),
      familyId: state.family._id,
      itemId: String(item._id),
      type: 'stocktake',
      qty: remaining,
      amount: null,
      channel: null,
      note: p.note || null,
      occurredAt: p.occurredAt ? new Date(p.occurredAt) : now(),
      createdBy: 'openid-demo',
      createdAt: now()
    };
    state.events.push(event);
    return { eventId: event._id, item: viewOf(item._id) };
  },

  'item/usedUp': async (payload) => {
    const p = payload || {};
    const item = findItem(p.itemId);
    if (!item) return fail('ITEM_NOT_FOUND', '找不到这个物品');
    const event = {
      _id: nextId('ev'),
      familyId: state.family._id,
      itemId: String(item._id),
      type: 'used_up',
      qty: 0,
      amount: null,
      channel: null,
      note: p.note || null,
      occurredAt: p.occurredAt ? new Date(p.occurredAt) : now(),
      createdBy: 'openid-demo',
      createdAt: now()
    };
    state.events.push(event);
    return { eventId: event._id, item: viewOf(item._id) };
  },

  // ---------------- 记一笔

  'purchase/add': async (payload) => {
    const p = payload || {};
    const entries = p.entries || [];
    if (!entries.length) return fail('INVALID_INPUT', '没有要记录的物品');
    const created = [];
    const itemIds = [];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const item = findItem(entry.itemId);
      if (!item) return fail('ITEM_NOT_FOUND', '找不到这个物品');
      const qty = Number(entry.qty);
      if (!Number.isFinite(qty) || qty <= 0) return fail('INVALID_INPUT', '数量必须是正数');
      const amount = entry.amount === undefined || entry.amount === null || Number(entry.amount) === 0
        ? null
        : Number(entry.amount);
      const event = {
        _id: nextId('ev'),
        familyId: state.family._id,
        itemId: String(item._id),
        type: 'purchase',
        qty,
        amount,
        channel: entry.channel || null,
        brand: entry.brand || item.brand || null,
        spec: entry.spec || item.spec || null,
        note: entry.note || null,
        occurredAt: p.occurredAt ? new Date(p.occurredAt) : now(),
        createdBy: 'openid-demo',
        createdAt: now()
      };
      state.events.push(event);
      created.push(event._id);
      if (itemIds.indexOf(String(item._id)) < 0) itemIds.push(String(item._id));
    }
    return {
      created,
      occurredAt: p.occurredAt ? new Date(p.occurredAt) : now(),
      items: itemIds.map(viewOf).filter(Boolean)
    };
  },

  'purchase/remove': async (payload) => {
    const p = payload || {};
    const ids = (p.eventIds || (p.eventId ? [p.eventId] : [])).map(String);
    if (!ids.length) return fail('INVALID_INPUT', '没有要撤销的记录');
    const mine = state.events.filter((e) => ids.indexOf(String(e._id)) >= 0);
    if (!mine.length) return fail('EVENT_NOT_FOUND', '这条记录已经不存在了');
    const itemIds = [];
    mine.forEach((e) => {
      if (itemIds.indexOf(String(e.itemId)) < 0) itemIds.push(String(e.itemId));
    });
    state.events = state.events.filter((e) => ids.indexOf(String(e._id)) < 0);
    return { removed: mine.map((e) => e._id), items: itemIds.map(viewOf).filter(Boolean) };
  },

  'purchase/update': async (payload) => {
    const p = payload || {};
    const target = state.events.find((e) => String(e._id) === String(p.eventId));
    if (!target) return fail('EVENT_NOT_FOUND', '这条记录已经不存在了');
    if (target.type !== 'purchase') return fail('INVALID_INPUT', '只有购买记录可以改金额或数量');
    const patch = p.patch || {};
    if (patch.amount !== undefined) {
      const amount = Number(patch.amount);
      target.amount = !Number.isFinite(amount) || amount === 0 ? null : amount;
    }
    if (patch.qty !== undefined) {
      const qty = Number(patch.qty);
      if (!Number.isFinite(qty) || qty <= 0) return fail('INVALID_INPUT', '数量必须是正数');
      target.qty = qty;
    }
    if (patch.channel !== undefined) target.channel = patch.channel || null;
    if (patch.note !== undefined) target.note = patch.note || null;
    return { eventId: target._id, items: [viewOf(target.itemId)].filter(Boolean) };
  },

  'purchase/recent': async (payload) => {
    const limit = Number((payload && payload.limit) || 20);
    const byId = {};
    state.items.forEach((it) => {
      byId[String(it._id)] = it;
    });
    const list = state.events
      .slice()
      .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))
      .slice(0, limit)
      .map((e) => {
        const item = byId[String(e.itemId)] || {};
        return Object.assign({}, e, {
          itemName: item.name || '已删除的物品',
          unit: item.unit || '',
          category: item.category || '其他'
        });
      });
    return { events: list };
  },

  'purchase/frequent': async (payload) => {
    const limit = Number((payload && payload.limit) || 12);
    const scored = views().map((v) => {
      const purchases = eventsOf(v._id).filter((e) => e.type === 'purchase');
      const last = purchases.reduce((acc, e) => Math.max(acc, new Date(e.occurredAt).getTime()), 0);
      return { view: v, count: purchases.length, last };
    });
    scored.sort((a, b) => {
      const ar = a.view.shouldRefill ? 0 : 1;
      const br = b.view.shouldRefill ? 0 : 1;
      if (ar !== br) return ar - br;
      if (a.count !== b.count) return b.count - a.count;
      if (a.last !== b.last) return b.last - a.last;
      return String(a.view.name).localeCompare(String(b.view.name), 'zh');
    });
    return {
      items: scored.slice(0, limit).map((s) => Object.assign({}, s.view, { purchaseCount: s.count })),
      remindDays: settings().remindDays
    };
  },

  // ---------------- 首页与统计

  'dashboard/home': async () => {
    if (!state.family) {
      return { needOnboarding: true, family: null, me: null, members: [], refill: [], ok: [], summary: null };
    }
    const all = views();
    const refill = core.buildRefillList(all);
    const ok = core.buildOkList(all);
    const month = core.summarizeMonthly(state.events, now(), indexById(state.items));
    return {
      needOnboarding: false,
      family: state.family,
      me: state.me,
      members: state.members,
      remindDays: settings().remindDays,
      refill,
      ok,
      summary: {
        itemCount: all.length,
        refillCount: refill.length,
        overdueCount: refill.filter((v) => v.stock <= 0).length,
        monthTotal: month.total,
        monthCount: month.count,
        monthMissingAmount: month.missingAmountCount,
        monthLabel: `${month.month.getFullYear()} 年 ${month.month.getMonth() + 1} 月`
      },
      serverTime: now()
    };
  },

  'stats/monthly': async (payload) => {
    const p = payload || {};
    let month;
    if (p.month) {
      const m = /^(\d{4})-(\d{1,2})$/.exec(String(p.month));
      month = m ? new Date(Number(m[1]), Number(m[2]) - 1, 1) : new Date(now().getFullYear(), now().getMonth(), 1);
    } else {
      month = new Date(now().getFullYear(), now().getMonth(), 1);
    }
    const itemsById = indexById(state.items);
    const all = views();
    const current = core.summarizeMonthly(state.events, month, itemsById);
    const previous = core.summarizeMonthly(state.events, core.previousMonth(month), itemsById);
    const prices = {};
    state.events.forEach((e) => {
      if (e.type !== 'purchase' || e.amount === null || !e.qty) return;
      const key = String(e.itemId);
      if (!prices[key]) prices[key] = { amount: 0, qty: 0 };
      prices[key].amount += Number(e.amount);
      prices[key].qty += Number(e.qty);
    });
    const predicted = all
      .filter((v) => v.rate > 0)
      .map((v) => {
        const acc = prices[String(v._id)];
        const unitPrice = acc && acc.qty > 0 ? acc.amount / acc.qty : null;
        return {
          itemId: String(v._id),
          name: v.name,
          category: v.category,
          unit: v.unit,
          rate: v.rate,
          monthlyQty: core.round(v.rate * 30, 2),
          unitPrice,
          monthlyCost: unitPrice === null ? null : core.round(v.rate * 30 * unitPrice, 2)
        };
      })
      .sort((a, b) => (b.monthlyCost || 0) - (a.monthlyCost || 0));

    return {
      month: `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`,
      current,
      previous,
      mom: core.monthOverMonth(current.total, previous.total),
      rank: core.summarizeByItem(state.events, month, itemsById),
      trend: core.monthlyTrend(state.events, month, 6, itemsById),
      predicted,
      predictedTotal: core.round(
        predicted.reduce((s, x) => s + (x.monthlyCost || 0), 0),
        2
      ),
      unestimableCount: all.filter((v) => !v.estimable).length,
      itemCount: all.length
    };
  },

  'notify/preview': async () => {
    if (!state.family) return { hasContent: false, payload: null, refillCount: 0, itemCount: 0 };
    const all = views();
    const refill = core.buildRefillList(all);
    const { hasContent, payload } = core.buildPushPayload(state.family, refill, now());
    const conf = settings();
    return {
      hasContent,
      payload,
      refillCount: refill.length,
      itemCount: all.length,
      pushTime: conf.pushTime,
      pushEnabled: conf.pushEnabled !== false,
      templateConfigured: Boolean(conf.templateId),
      quota: (state.me && state.me.subQuota && state.me.subQuota.remaining) || 0,
      serverTime: now()
    };
  },

  'mock/reset': async () => {
    state = seed();
    seededAt = state.seededAt;
    persist();
    return { reset: true };
  }
};

function indexById(items) {
  const map = {};
  (items || []).forEach((it) => {
    map[String(it._id)] = it;
  });
  return map;
}

// ---------------------------------------------------------------- 对外接口

function init(options = {}) {
  latency = options.latency === undefined ? 120 : options.latency;
  storage = options.storage || defaultStorage();
  const saved = storage.get();
  if (saved && saved.family !== undefined) {
    state = saved;
    // 演示数据只在第一次生成，之后即使重进也保持你改过的样子
  } else {
    state = seed(options.now ? options.now() : new Date());
    persist();
  }
  return { reset: () => handlers['mock/reset']() };
}

async function call(name, action, payload) {
  const fn = handlers[`${name}/${action}`];
  if (!fn) return fail('UNKNOWN_ACTION', `演示模式还没实现 ${name}.${action}`);
  await sleep(latency);
  try {
    const data = await fn(payload || {});
    if (data && data.ok === false) return data;
    persist();
    return { ok: true, data: respond(data) };
  } catch (e) {
    return fail('MOCK_ERROR', `演示模式出错：${(e && e.message) || e}`);
  }
}

module.exports = {
  init,
  call,
  seed,
  handlers,
  /** 测试用：直接查看内部状态 */
  _state: () => state,
  _setState: (next) => {
    state = next;
  }
};

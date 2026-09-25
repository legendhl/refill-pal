'use strict';

/**
 * 云函数共用工具（与 core.js 一样由 scripts/sync-shared.js 同步到各云函数 shared/ 下）。
 *
 * 安全模型（重要）：
 *   familyId **永远不从客户端读取**，一律由云函数根据 openid 反查 members 得到。
 *   因此客户端即使伪造 familyId 也读不到别人家的数据。
 */

const core = require('./core');

/** 业务错误：带上 appCode 后会被 app.js 统一转成 { ok:false, code, message } */
function appError(code, message) {
  const e = new Error(message);
  e.appCode = code;
  return e;
}

const DEFAULT_SETTINGS = {
  remindDays: 3,
  pushTime: '09:00',
  pushEnabled: true
};

/** 邀请码字母表：去掉了 0/O/1/I 等易混字符 */
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateInviteCode(length = 6, random = Math.random) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += INVITE_ALPHABET[Math.floor(random() * INVITE_ALPHABET.length)];
  }
  return out;
}

/** 分页取全量（云数据库单次 get 有上限，服务端 1000 条） */
async function fetchAll(query, options = {}) {
  const pageSize = options.pageSize || 1000;
  const max = options.max || 5000;
  const out = [];
  for (let skip = 0; skip < max; skip += pageSize) {
    /* eslint-disable no-await-in-loop */
    const res = await query.skip(skip).limit(pageSize).get();
    const batch = (res && res.data) || [];
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

/** openid → { member, family }；不属于任何家庭时返回 null */
async function resolveFamily(db, openid) {
  const res = await db.collection('members').where({ openid }).limit(1).get();
  const member = (res && res.data && res.data[0]) || null;
  if (!member) return null;
  const fres = await db.collection('families').where({ _id: member.familyId }).limit(1).get();
  const family = (fres && fres.data && fres.data[0]) || null;
  if (!family) return null;
  return { member, family };
}

/** 必须已加入家庭，否则抛错 */
async function requireFamily(db, openid) {
  const ctx = await resolveFamily(db, openid);
  if (!ctx) throw appError('NO_FAMILY', '你还没有加入家庭，先创建一个或输入邀请码加入');
  return ctx;
}

function settingsOf(family) {
  return Object.assign({}, DEFAULT_SETTINGS, (family && family.settings) || {});
}

/** 校验物品属于本家庭，返回物品文档 */
async function requireOwnItem(db, familyId, itemId) {
  if (!itemId) throw appError('INVALID_INPUT', '缺少物品 ID');
  const res = await db.collection('items').where({ _id: String(itemId), familyId }).limit(1).get();
  const item = (res && res.data && res.data[0]) || null;
  if (!item) throw appError('ITEM_NOT_FOUND', '找不到这个物品，可能已经被删掉了');
  return item;
}

function groupEventsByItem(events) {
  const map = {};
  (events || []).forEach((e) => {
    const key = String(e.itemId);
    if (!map[key]) map[key] = [];
    map[key].push(e);
  });
  return map;
}

/** itemId → item 的索引，用于统计时按分类归集 */
function indexById(items) {
  const map = {};
  (items || []).forEach((it) => {
    map[String(it._id)] = it;
  });
  return map;
}

/**
 * 读取一个家庭的全部物品与流水，算出视图、待补货列表、还够用列表。
 * 首页、物品页、统计页都走这一个入口，保证三处口径完全一致。
 */
async function loadFamilyViews(db, family, now) {
  const settings = settingsOf(family);
  const [items, events] = await Promise.all([
    fetchAll(db.collection('items').where({ familyId: family._id })),
    fetchAll(db.collection('events').where({ familyId: family._id }).orderBy('occurredAt', 'desc'))
  ]);
  const eventsByItem = groupEventsByItem(events);
  const views = core.resolveAll(items, eventsByItem, now, { remindDays: settings.remindDays });
  return {
    settings,
    items,
    events,
    eventsByItem,
    views,
    refill: core.buildRefillList(views),
    ok: core.buildOkList(views)
  };
}

/**
 * 单个物品的视图与时间轴。
 *
 * 刻意不走 loadFamilyViews：那个函数按列表口径排除了归档物品，
 * 而详情页**必须能打开归档物品**（否则归档后一点进去就报「找不到这个物品」）。
 * 顺带也比拉全家的流水更省。
 */
async function loadItemDetail(db, family, itemId, now) {
  const item = await requireOwnItem(db, family._id, String(itemId));
  const events = await fetchAll(
    db
      .collection('events')
      .where({ familyId: family._id, itemId: String(item._id) })
      .orderBy('occurredAt', 'asc')
  );
  const settings = settingsOf(family);
  return {
    item,
    events,
    view: core.buildItemView(item, events, now, { remindDays: settings.remindDays }),
    remindDays: settings.remindDays
  };
}

/** 把 Date 递归转成 ISO 字符串，保证返回值与客户端所见完全一致（也便于断言） */
function toJSON(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

/** 去掉不该下发给客户端的字段（openid 等） */
function publicMember(member) {
  return {
    _id: member._id,
    familyId: member.familyId,
    nickName: member.nickName || '家人',
    avatar: member.avatar || '',
    role: member.role || 'member',
    joinedAt: member.joinedAt,
    subQuota: member.subQuota || { remaining: 0, updatedAt: null }
  };
}

function publicFamily(family) {
  return {
    _id: family._id,
    name: family.name,
    inviteCode: family.inviteCode,
    createdBy: family.createdBy,
    createdAt: family.createdAt,
    settings: settingsOf(family)
  };
}

// ---------------------------------------------------------------- 输入校验

function str(value, { field, max = 30, required = false, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw appError('INVALID_INPUT', `${field}不能为空`);
    return fallback;
  }
  const s = String(value).trim();
  if (!s) {
    if (required) throw appError('INVALID_INPUT', `${field}不能为空`);
    return fallback;
  }
  if (s.length > max) throw appError('INVALID_INPUT', `${field}太长了，最多 ${max} 个字`);
  return s;
}

function num(value, { field, min = -Infinity, max = Infinity, required = false, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw appError('INVALID_INPUT', `${field}不能为空`);
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw appError('INVALID_INPUT', `${field}必须是数字`);
  if (n < min) throw appError('INVALID_INPUT', `${field}不能小于 ${min}`);
  if (n > max) throw appError('INVALID_INPUT', `${field}不能大于 ${max}`);
  return n;
}

/** 解析业务发生时间：允许过去（补录），但不允许明显未来（超过 1 天视为误填） */
function parseOccurredAt(value, now) {
  if (value === undefined || value === null || value === '') return now;
  const d = core.toDate(value);
  if (Number.isNaN(d.getTime())) throw appError('INVALID_INPUT', '日期格式不对');
  const limit = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (d.getTime() > limit.getTime()) throw appError('INVALID_INPUT', '日期不能填未来');
  return d;
}

/** 解析 'YYYY-MM' 或 Date → 该月 1 号 00:00 */
function parseMonth(value, now) {
  if (!value) return new Date(now.getFullYear(), now.getMonth(), 1);
  if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), 1);
  const m = /^(\d{4})-(\d{1,2})$/.exec(String(value).trim());
  if (!m) throw appError('INVALID_INPUT', '月份格式应为 YYYY-MM');
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw appError('INVALID_INPUT', '月份应在 1-12 之间');
  return new Date(year, month - 1, 1);
}

// ---------------------------------------------------------------- 统一入口

/**
 * 把 handlers 包成云函数 main：统一取 openid、统一错误码、统一序列化。
 * 每个云函数的 app.js 只需要写 handlers。
 */
function createHandler(handlers, deps) {
  return async function handle(event) {
    const action = (event && event.action) || '';
    const payload = (event && event.payload) || {};
    let openid = null;
    try {
      openid = await deps.getOpenId();
      if (!openid) {
        return { ok: false, code: 'NO_OPENID', message: '无法获取用户身份，请重新进入小程序' };
      }
      const fn = handlers[action];
      if (!fn) {
        return { ok: false, code: 'UNKNOWN_ACTION', message: `未知操作：${action}` };
      }
      const now = deps.now ? deps.now() : new Date();
      const data = await fn({ openid, payload, db: deps.db, _: deps._, now, deps });
      return { ok: true, data: toJSON(data) };
    } catch (e) {
      if (e && e.appCode) {
        return { ok: false, code: e.appCode, message: e.message };
      }
      // 未预期的异常要打日志，但不要把小程序的错误细节暴露给用户
      console.error(`[RefillPal] ${action} 未捕获异常`, e && e.stack ? e.stack : e);
      return { ok: false, code: 'INTERNAL', message: '服务开小差了，请稍后再试' };
    }
  };
}

module.exports = {
  core,
  appError,
  DEFAULT_SETTINGS,
  INVITE_ALPHABET,
  generateInviteCode,
  fetchAll,
  resolveFamily,
  requireFamily,
  requireOwnItem,
  settingsOf,
  groupEventsByItem,
  indexById,
  loadFamilyViews,
  loadItemDetail,
  toJSON,
  publicMember,
  publicFamily,
  str,
  num,
  parseOccurredAt,
  parseMonth,
  createHandler
};

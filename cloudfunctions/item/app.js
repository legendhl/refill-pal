'use strict';

/**
 * item 云函数：物品的增删改查、盘点、用完、归档。
 *
 * 读取路径统一走 kit.loadFamilyViews（= core 的事件溯源重放），
 * 所以「物品页看到的库存」与「首页待补货」永远同源同口径。
 */

const kit = require('./shared/kit');

/** 写入后重新解析该物品的视图，直接回给客户端，省一次往返 */
async function viewAfterWrite(ctx, familyId, itemId) {
  const found = await kit.resolveFamily(ctx.db, ctx.openid);
  const { views } = await kit.loadFamilyViews(ctx.db, found.family, ctx.now);
  return views.find((v) => String(v._id) === String(itemId)) || null;
}

async function itemEvents(ctx, familyId, itemId) {
  return kit.fetchAll(
    ctx.db.collection('events').where({ familyId, itemId: String(itemId) }).orderBy('occurredAt', 'asc')
  );
}

const handlers = {
  /** 物品页：全部物品（含库存与预测），已排除归档 */
  async list(ctx) {
    const { db, openid, now } = ctx;
    const { family } = await kit.requireFamily(db, openid);
    const { views, settings } = await kit.loadFamilyViews(db, family, now);
    return {
      items: views.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh')),
      remindDays: settings.remindDays
    };
  },

  /** 物品详情：视图 + 完整时间轴 */
  async detail(ctx) {
    const { db, openid, payload, now } = ctx;
    const { family } = await kit.requireFamily(db, openid);
    const item = await kit.requireOwnItem(db, family._id, payload.itemId);
    const { views, settings } = await kit.loadFamilyViews(db, family, now);
    const view = views.find((v) => String(v._id) === String(item._id)) || null;
    const events = await itemEvents(ctx, family._id, item._id);
    return { item: view, events, remindDays: settings.remindDays };
  },

  async create(ctx) {
    const { db, openid, payload, now } = ctx;
    const { family } = await kit.requireFamily(db, openid);

    const name = kit.str(payload.name, { field: '物品名', max: 20, required: true });
    const category = kit.str(payload.category, { field: '分类', max: 10, fallback: '其他' });
    const unit = kit.str(payload.unit, { field: '单位', max: 4, fallback: '个' });
    const brand = kit.str(payload.brand, { field: '品牌', max: 20, fallback: null });
    const spec = kit.str(payload.spec, { field: '规格', max: 20, fallback: null });
    const initEstimateDays = kit.num(payload.initEstimateDays, {
      field: '预计可用天数',
      min: 1,
      max: 3650,
      fallback: null
    });
    const baseQty = kit.num(payload.baseQty, { field: '现有数量', min: 0, max: 99999, fallback: 0 });

    // 同名物品会让「记一笔」只能猜，直接拒绝并告诉用户该怎么办
    const dup = await db
      .collection('items')
      .where({ familyId: family._id, name })
      .limit(5)
      .get();
    const activeDup = dup.data.filter((d) => d.status !== 'archived');
    if (activeDup.length) {
      throw kit.appError('DUPLICATE_NAME', `已经有一个叫「${name}」的物品了，直接给它点一下就行`);
    }

    const { _id } = await db.collection('items').add({
      data: {
        familyId: family._id,
        name,
        category,
        unit,
        brand,
        spec,
        initEstimateDays,
        // 事件溯源的不可变基准点：创建时家里已有多少
        baseAt: now,
        baseQty,
        status: 'active',
        createdBy: openid,
        createdAt: now,
        updatedAt: now
      }
    });

    return { item: await viewAfterWrite(ctx, family._id, _id) };
  },

  async update(ctx) {
    const { db, openid, payload } = ctx;
    const { family } = await kit.requireFamily(db, openid);
    const item = await kit.requireOwnItem(db, family._id, payload.itemId);
    const patch = payload.patch || {};

    // 白名单更新。baseAt/baseQty 刻意不允许改：
    // 「现在还剩多少」必须通过盘点流水表达，否则事件溯源的事实链会被破坏。
    const next = { updatedAt: ctx.now };
    if (patch.name !== undefined) {
      const name = kit.str(patch.name, { field: '物品名', max: 20, required: true });
      if (name !== item.name) {
        const dup = await db.collection('items').where({ familyId: family._id, name }).limit(5).get();
        if (dup.data.filter((d) => d.status !== 'archived' && String(d._id) !== String(item._id)).length) {
          throw kit.appError('DUPLICATE_NAME', `已经有一个叫「${name}」的物品了`);
        }
      }
      next.name = name;
    }
    if (patch.category !== undefined) {
      next.category = kit.str(patch.category, { field: '分类', max: 10, fallback: '其他' });
    }
    if (patch.unit !== undefined) next.unit = kit.str(patch.unit, { field: '单位', max: 4, fallback: '个' });
    if (patch.brand !== undefined) next.brand = kit.str(patch.brand, { field: '品牌', max: 20, fallback: null });
    if (patch.spec !== undefined) next.spec = kit.str(patch.spec, { field: '规格', max: 20, fallback: null });
    if (patch.initEstimateDays !== undefined) {
      next.initEstimateDays = kit.num(patch.initEstimateDays, {
        field: '预计可用天数',
        min: 1,
        max: 3650,
        fallback: null
      });
    }

    await db.collection('items').where({ _id: item._id }).update({ data: next });
    return { item: await viewAfterWrite(ctx, family._id, item._id) };
  },

  async archive(ctx) {
    const { db, openid, payload } = ctx;
    const { family } = await kit.requireFamily(db, openid);
    const item = await kit.requireOwnItem(db, family._id, payload.itemId);
    await db.collection('items').where({ _id: item._id }).update({ data: { status: 'archived', updatedAt: ctx.now } });
    return { archived: item._id };
  },

  async restore(ctx) {
    const { db, openid, payload } = ctx;
    const { family } = await kit.requireFamily(db, openid);
    const item = await kit.requireOwnItem(db, family._id, payload.itemId);
    await db.collection('items').where({ _id: item._id }).update({ data: { status: 'active', updatedAt: ctx.now } });
    return { item: await viewAfterWrite(ctx, family._id, item._id) };
  },

  /** 彻底删除物品及其全部流水。用于建错了想清掉。 */
  async remove(ctx) {
    const { db, openid, payload } = ctx;
    const { family } = await kit.requireFamily(db, openid);
    const item = await kit.requireOwnItem(db, family._id, payload.itemId);
    await db.collection('events').where({ familyId: family._id, itemId: String(item._id) }).remove();
    await db.collection('items').where({ _id: item._id }).remove();
    return { removed: item._id };
  },

  /**
   * 盘点：把库存校准为「还剩 N」。
   * 盘点数据同时是最有价值的速率证据（能排除囤货干扰），所以这里要鼓励用户用。
   */
  async stocktake(ctx) {
    const { db, openid, payload, now } = ctx;
    const { family } = await kit.requireFamily(db, openid);
    const item = await kit.requireOwnItem(db, family._id, payload.itemId);
    const remaining = kit.num(payload.remaining, { field: '剩余数量', min: 0, max: 99999, required: true });
    const occurredAt = kit.parseOccurredAt(payload.occurredAt, now);

    // 异常值保护：剩余量不可能超过「初始库存 + 历次购买总和」
    if (!payload.force) {
      const { eventsByItem } = await kit.loadFamilyViews(db, family, now);
      const history = eventsByItem[String(item._id)] || [];
      const everOwned =
        (Number(item.baseQty) || 0) +
        history.filter((e) => e.type === 'purchase').reduce((s, e) => s + (Number(e.qty) || 0), 0);
      if (remaining > everOwned + 0.001) {
        return {
          confirmNeeded: true,
          message: `记录里这个物品一共只买过 ${everOwned} ${item.unit}，你填的是 ${remaining} ${item.unit}，确定没填错吗？`
        };
      }
    }

    const { _id } = await db.collection('events').add({
      data: {
        familyId: family._id,
        itemId: String(item._id),
        type: 'stocktake',
        qty: remaining,
        amount: null,
        channel: null,
        brand: null,
        spec: null,
        occurredAt,
        note: kit.str(payload.note, { field: '备注', max: 50, fallback: null }),
        createdBy: openid,
        createdAt: now
      }
    });

    return { eventId: _id, item: await viewAfterWrite(ctx, family._id, item._id) };
  },

  /** 用完：等价于盘点为 0，但它是消耗周期的闭合信号，对估算价值最高 */
  async usedUp(ctx) {
    const { db, openid, payload, now } = ctx;
    const { family } = await kit.requireFamily(db, openid);
    const item = await kit.requireOwnItem(db, family._id, payload.itemId);
    const occurredAt = kit.parseOccurredAt(payload.occurredAt, now);

    const { _id } = await db.collection('events').add({
      data: {
        familyId: family._id,
        itemId: String(item._id),
        type: 'used_up',
        qty: 0,
        amount: null,
        channel: null,
        brand: null,
        spec: null,
        occurredAt,
        note: kit.str(payload.note, { field: '备注', max: 50, fallback: null }),
        createdBy: openid,
        createdAt: now
      }
    });

    return { eventId: _id, item: await viewAfterWrite(ctx, family._id, item._id) };
  }
};

module.exports = {
  handlers,
  createApp: (deps) => ({ handle: kit.createHandler(handlers, deps) })
};

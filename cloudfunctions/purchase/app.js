'use strict';

/**
 * purchase 云函数：「记一笔」、撤销、常用物品排序、流水列表。
 *
 * 「记一笔」是整个产品使用频率最高的动作，所以这里的 add 支持一次提交多条，
 * 也支持完全不填金额/渠道 —— 不该因为表单字段拖慢 3 秒路径。
 */

const kit = require('./shared/kit');

async function viewsOf(ctx, family, itemIds) {
  const { views } = await kit.loadFamilyViews(ctx.db, family, ctx.now);
  const wanted = itemIds.map(String);
  return views.filter((v) => wanted.indexOf(String(v._id)) >= 0);
}

async function buildEntries(ctx, family, rawEntries) {
  const { db } = ctx;
  if (!Array.isArray(rawEntries) || !rawEntries.length) {
    throw kit.appError('INVALID_INPUT', '没有要记录的物品');
  }
  if (rawEntries.length > 20) {
    throw kit.appError('INVALID_INPUT', '一次最多记 20 条');
  }

  const items = await kit.fetchAll(db.collection('items').where({ familyId: family._id }));
  const byId = {};
  items.forEach((it) => {
    byId[String(it._id)] = it;
  });

  return rawEntries.map((raw) => {
    const entry = raw || {};
    const itemId = String(entry.itemId || '');
    const item = byId[itemId];
    if (!item) throw kit.appError('ITEM_NOT_FOUND', '找不到这个物品，可能已经被删掉了');
    if (item.status === 'archived') throw kit.appError('ITEM_ARCHIVED', `「${item.name}」已归档，先恢复再记`);

    const qty = kit.num(entry.qty, { field: '数量', min: 0.01, max: 99999, required: true });
    let amount = kit.num(entry.amount, { field: '金额', min: 0, max: 999999, fallback: null });
    if (amount === 0) amount = null; // 0 元等同于没填，避免污染统计

    return {
      item,
      event: {
        familyId: family._id,
        itemId,
        type: 'purchase',
        qty,
        amount,
        channel: kit.str(entry.channel, { field: '渠道', max: 10, fallback: null }),
        brand: kit.str(entry.brand, { field: '品牌', max: 20, fallback: item.brand || null }),
        spec: kit.str(entry.spec, { field: '规格', max: 20, fallback: item.spec || null }),
        note: kit.str(entry.note, { field: '备注', max: 50, fallback: null })
      }
    };
  });
}

const handlers = {
  /** 记一笔（可多条）。返回更新后的物品视图，客户端无需再拉一次首页。 */
  async add(ctx) {
    const { db, openid, payload, now } = ctx;
    const { family } = await kit.requireFamily(db, openid);
    const occurredAt = kit.parseOccurredAt(payload.occurredAt, now);
    const entries = await buildEntries(ctx, family, payload.entries);

    const createdIds = [];
    for (let i = 0; i < entries.length; i += 1) {
      const { event } = entries[i];
      // eslint-disable-next-line no-await-in-loop
      const res = await db.collection('events').add({
        data: Object.assign({}, event, { occurredAt, createdBy: openid, createdAt: now })
      });
      createdIds.push(res._id);
    }

    const itemIds = entries.map((e) => String(e.item._id));
    return {
      created: createdIds,
      occurredAt,
      items: await viewsOf(ctx, family, itemIds)
    };
  },

  /** 撤销 / 批量删除流水 */
  async remove(ctx) {
    const { db, openid, payload } = ctx;
    const { family } = await kit.requireFamily(db, openid);
    const ids = (Array.isArray(payload.eventIds) ? payload.eventIds : [payload.eventId])
      .filter(Boolean)
      .map(String);
    if (!ids.length) throw kit.appError('INVALID_INPUT', '没有要撤销的记录');
    if (ids.length > 50) throw kit.appError('INVALID_INPUT', '一次最多撤销 50 条');

    // 只删属于本家庭的流水：先查出来核对归属，再逐条删除
    const rows = await kit.fetchAll(
      db.collection('events').where({ familyId: family._id }).orderBy('occurredAt', 'desc'),
      { max: 5000 }
    );
    const mine = rows.filter((r) => ids.indexOf(String(r._id)) >= 0);
    if (!mine.length) throw kit.appError('EVENT_NOT_FOUND', '这条记录已经不存在了');

    const itemIds = [];
    for (let i = 0; i < mine.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await db.collection('events').where({ _id: mine[i]._id }).remove();
      if (itemIds.indexOf(String(mine[i].itemId)) < 0) itemIds.push(String(mine[i].itemId));
    }

    return {
      removed: mine.map((r) => r._id),
      items: await viewsOf(ctx, family, itemIds)
    };
  },

  /** 补金额 / 改数量 / 改渠道。事件溯源让「改历史」是安全的：库存会跟着重算。 */
  async update(ctx) {
    const { db, openid, payload } = ctx;
    const { family } = await kit.requireFamily(db, openid);
    const eventId = kit.str(payload.eventId, { field: '记录', max: 40, required: true });
    const patch = payload.patch || {};

    const rows = await kit.fetchAll(
      db.collection('events').where({ familyId: family._id }).orderBy('occurredAt', 'desc'),
      { max: 5000 }
    );
    const target = rows.find((r) => String(r._id) === eventId);
    if (!target) throw kit.appError('EVENT_NOT_FOUND', '这条记录已经不存在了');
    if (target.type !== 'purchase') {
      throw kit.appError('INVALID_INPUT', '只有购买记录可以改金额或数量');
    }

    const next = {};
    if (patch.amount !== undefined) {
      const amount = kit.num(patch.amount, { field: '金额', min: 0, max: 999999, fallback: null });
      next.amount = amount === 0 ? null : amount;
    }
    if (patch.qty !== undefined) {
      next.qty = kit.num(patch.qty, { field: '数量', min: 0.01, max: 99999, required: true });
    }
    if (patch.channel !== undefined) {
      next.channel = kit.str(patch.channel, { field: '渠道', max: 10, fallback: null });
    }
    if (patch.note !== undefined) {
      next.note = kit.str(patch.note, { field: '备注', max: 50, fallback: null });
    }
    if (!Object.keys(next).length) throw kit.appError('INVALID_INPUT', '没有要修改的内容');

    await db.collection('events').where({ _id: target._id }).update({ data: next });
    return {
      eventId: target._id,
      items: await viewsOf(ctx, family, [String(target.itemId)])
    };
  },

  /** 最近的流水（物品详情之外的一个总览，也用于「我最近记了什么」） */
  async recent(ctx) {
    const { db, openid, payload } = ctx;
    const { family } = await kit.requireFamily(db, openid);
    const limit = kit.num(payload.limit, { field: '条数', min: 1, max: 50, fallback: 20 });
    const rows = await db
      .collection('events')
      .where({ familyId: family._id })
      .orderBy('occurredAt', 'desc')
      .limit(limit)
      .get();
    const items = await kit.fetchAll(db.collection('items').where({ familyId: family._id }));
    const byId = {};
    items.forEach((it) => {
      byId[String(it._id)] = it;
    });
    return {
      events: rows.data.map((e) => {
        const item = byId[String(e.itemId)] || {};
        return Object.assign({}, e, {
          itemName: item.name || '已删除的物品',
          unit: item.unit || '',
          category: item.category || '其他'
        });
      })
    };
  },

  /** 常用物品排序：给「记一笔」宫格用。按购买次数降序，其次按最近购买时间。 */
  async frequent(ctx) {
    const { db, openid, payload, now } = ctx;
    const { family } = await kit.requireFamily(db, openid);
    const limit = kit.num(payload.limit, { field: '数量', min: 1, max: 60, fallback: 12 });
    const { views, eventsByItem, settings } = await kit.loadFamilyViews(db, family, now);

    const scored = views.map((v) => {
      const history = eventsByItem[String(v._id)] || [];
      const purchases = history.filter((e) => e.type === 'purchase');
      const last = purchases.reduce((acc, e) => {
        const t = kit.core.toDate(e.occurredAt).getTime();
        return t > acc ? t : acc;
      }, 0);
      return { view: v, count: purchases.length, last };
    });

    scored.sort((a, b) => {
      // 待补货的排前面，让最容易点错的顺序反而是对的
      const ar = a.view.shouldRefill ? 0 : 1;
      const br = b.view.shouldRefill ? 0 : 1;
      if (ar !== br) return ar - br;
      if (a.count !== b.count) return b.count - a.count;
      if (a.last !== b.last) return b.last - a.last;
      return String(a.view.name).localeCompare(String(b.view.name), 'zh');
    });

    return {
      items: scored.slice(0, limit).map((s) => Object.assign({}, s.view, { purchaseCount: s.count })),
      remindDays: settings.remindDays
    };
  }
};

module.exports = {
  handlers,
  createApp: (deps) => ({ handle: kit.createHandler(handlers, deps) })
};

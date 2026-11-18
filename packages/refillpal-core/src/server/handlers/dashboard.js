'use strict';

/**
 * dashboard 云函数：首页一次聚合返回，避免小程序端多次串行请求。
 *
 * 首页是打开小程序看到的第一屏，必须一次到位：
 * 待补货、还够用、本月概览、家庭信息全部一次给全。
 */

const kit = require('../kit');

const handlers = {
  async home(ctx) {
    const { db, openid, now } = ctx;
    const found = await kit.resolveFamily(db, openid);
    if (!found) {
      return { needOnboarding: true, family: null, me: null, members: [], refill: [], ok: [], summary: null };
    }

    const { family, member } = found;
    const [loaded, members] = await Promise.all([
      kit.loadFamilyViews(db, family, now),
      kit.fetchAll(db.collection('members').where({ familyId: family._id }))
    ]);

    const month = kit.core.summarizeMonthly(loaded.events, now, kit.indexById(loaded.items));

    return {
      needOnboarding: false,
      family: kit.publicFamily(family),
      me: kit.publicMember(member),
      members: members.map(kit.publicMember),
      remindDays: loaded.settings.remindDays,
      refill: loaded.refill,
      ok: loaded.ok,
      summary: {
        itemCount: loaded.views.length,
        refillCount: loaded.refill.length,
        overdueCount: loaded.refill.filter((v) => v.stock <= 0).length,
        monthTotal: month.total,
        monthCount: month.count,
        monthMissingAmount: month.missingAmountCount,
        monthLabel: `${month.month.getFullYear()} 年 ${month.month.getMonth() + 1} 月`
      },
      serverTime: now
    };
  }
};

module.exports = {
  handlers,
  createApp: (deps) => ({ handle: kit.createHandler(handlers, deps) })
};

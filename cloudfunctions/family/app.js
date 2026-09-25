'use strict';

/**
 * family 云函数：家庭的创建、加入、成员管理、提醒设置、订阅额度、数据导出。
 *
 * 所有 action 的 familyId 都来自 openid 反查，客户端传什么都不影响归属。
 */

const kit = require('./shared/kit');

function sortMembers(members) {
  return members.slice().sort((a, b) => {
    const ar = a.role === 'owner' ? 0 : 1;
    const br = b.role === 'owner' ? 0 : 1;
    if (ar !== br) return ar - br;
    return kit.core.toDate(a.joinedAt) - kit.core.toDate(b.joinedAt);
  });
}

async function buildProfile(ctx) {
  const { db, openid } = ctx;
  const found = await kit.resolveFamily(db, openid);
  if (!found) return { family: null, me: null, members: [] };
  const members = await kit.fetchAll(db.collection('members').where({ familyId: found.family._id }));
  return {
    family: kit.publicFamily(found.family),
    me: kit.publicMember(found.member),
    members: sortMembers(members).map(kit.publicMember)
  };
}

async function uniqueInviteCode(db) {
  for (let i = 0; i < 8; i += 1) {
    const code = kit.generateInviteCode();
    // eslint-disable-next-line no-await-in-loop
    const res = await db.collection('families').where({ inviteCode: code }).limit(1).get();
    if (!res.data.length) return code;
  }
  throw kit.appError('CODE_CONFLICT', '邀请码生成失败，请再试一次');
}

const handlers = {
  /** 我是谁、我在哪个家（首页与启动时调用） */
  async profile(ctx) {
    return buildProfile(ctx);
  },

  async create(ctx) {
    const { db, openid, payload, now } = ctx;
    const existing = await kit.resolveFamily(db, openid);
    if (existing) throw kit.appError('ALREADY_IN_FAMILY', '你已经在一个家庭里了');

    const name = kit.str(payload.name, { field: '家庭名', max: 16, fallback: '我家' });
    const nickName = kit.str(payload.nickName, { field: '昵称', max: 20, fallback: '我' });
    const avatar = kit.str(payload.avatar, { field: '头像', max: 500, fallback: '' });
    const inviteCode = await uniqueInviteCode(db);

    const { _id } = await db.collection('families').add({
      data: {
        name,
        inviteCode,
        createdBy: openid,
        createdAt: now,
        settings: Object.assign({}, kit.DEFAULT_SETTINGS)
      }
    });

    try {
      await db.collection('members').add({
        data: {
          familyId: _id,
          openid,
          nickName,
          avatar,
          role: 'owner',
          joinedAt: now,
          subQuota: { remaining: 0, updatedAt: now }
        }
      });
    } catch (e) {
      // 成员写失败就删掉刚建的家庭，避免留下一个谁也进不去的孤儿家庭
      await db.collection('families').where({ _id }).remove().catch(() => {});
      throw e;
    }

    return buildProfile(ctx);
  },

  async join(ctx) {
    const { db, openid, payload, now } = ctx;
    const existing = await kit.resolveFamily(db, openid);
    if (existing) throw kit.appError('ALREADY_IN_FAMILY', '你已经在一个家庭里了');

    const code = kit.str(payload.inviteCode, { field: '邀请码', max: 12, required: true }).toUpperCase();
    const res = await db.collection('families').where({ inviteCode: code }).limit(1).get();
    const family = res.data[0];
    if (!family) throw kit.appError('INVALID_CODE', '邀请码不对，让家人重新发一次');

    await db.collection('members').add({
      data: {
        familyId: family._id,
        openid,
        nickName: kit.str(payload.nickName, { field: '昵称', max: 20, fallback: '家人' }),
        avatar: kit.str(payload.avatar, { field: '头像', max: 500, fallback: '' }),
        role: 'member',
        joinedAt: now,
        subQuota: { remaining: 0, updatedAt: now }
      }
    });

    return buildProfile(ctx);
  },

  async rename(ctx) {
    const { db, openid, payload } = ctx;
    const { family } = await kit.requireFamily(db, openid);
    const name = kit.str(payload.name, { field: '家庭名', max: 16, required: true });
    await db.collection('families').where({ _id: family._id }).update({ data: { name } });
    return { name };
  },

  /** 提醒设置 */
  async updateSettings(ctx) {
    const { db, openid, payload } = ctx;
    const { family } = await kit.requireFamily(db, openid);
    const current = kit.settingsOf(family);
    const next = Object.assign({}, current);

    if (payload.remindDays !== undefined) {
      next.remindDays = kit.num(payload.remindDays, { field: '提前天数', min: 0, max: 30, required: true });
    }
    if (payload.pushTime !== undefined) {
      const t = kit.str(payload.pushTime, { field: '推送时间', max: 5, required: true });
      if (!/^\d{2}:\d{2}$/.test(t)) throw kit.appError('INVALID_INPUT', '推送时间格式应为 HH:mm');
      next.pushTime = t;
    }
    if (payload.pushEnabled !== undefined) {
      next.pushEnabled = Boolean(payload.pushEnabled);
    }

    await db.collection('families').where({ _id: family._id }).update({ data: { settings: next } });
    return { settings: next };
  },

  /** 客户端授权成功后续订额度（一次授权 = 一条消息） */
  async subscribe(ctx) {
    const { db, openid, payload, now } = ctx;
    const { member, family } = await kit.requireFamily(db, openid);
    const count = kit.num(payload.count, { field: '额度', min: 1, max: 20, fallback: 1 });
    const quota = member.subQuota || { remaining: 0 };
    const next = {
      remaining: (Number(quota.remaining) || 0) + count,
      updatedAt: now
    };
    await db.collection('members').where({ _id: member._id }).update({ data: { subQuota: next } });
    return { familyId: family._id, subQuota: next };
  },

  /** 推送失败回执：扣额度 / 或标记拒收 */
  async markPushResult(ctx) {
    const { db, payload } = ctx;
    const memberId = kit.str(payload.memberId, { field: '成员', max: 40, required: true });
    const consumed = kit.num(payload.consumed, { field: '消耗额度', min: 0, max: 1, fallback: 0 });
    if (consumed <= 0) return { updated: 0 };
    const res = await db.collection('members').where({ _id: memberId }).limit(1).get();
    const member = res.data[0];
    if (!member) return { updated: 0 };
    const quota = member.subQuota || { remaining: 0 };
    const next = {
      remaining: Math.max(0, (Number(quota.remaining) || 0) - consumed),
      updatedAt: ctx.now
    };
    await db.collection('members').where({ _id: member._id }).update({ data: { subQuota: next } });
    return { updated: 1, subQuota: next };
  },

  async removeMember(ctx) {
    const { db, openid, payload } = ctx;
    const { member, family } = await kit.requireFamily(db, openid);
    if (member.role !== 'owner') throw kit.appError('FORBIDDEN', '只有创建者可以移除成员');
    const memberId = kit.str(payload.memberId, { field: '成员', max: 40, required: true });
    if (memberId === member._id) throw kit.appError('INVALID_INPUT', '不能移除自己，用「退出家庭」');
    const res = await db.collection('members').where({ _id: memberId, familyId: family._id }).limit(1).get();
    if (!res.data.length) throw kit.appError('MEMBER_NOT_FOUND', '找不到这个成员');
    await db.collection('members').where({ _id: memberId }).remove();
    return { removed: memberId };
  },

  /** 退出家庭。创建者退出时把创建者身份移交给最早加入的成员。 */
  async leave(ctx) {
    const { db, openid, payload, now } = ctx;
    const { member, family } = await kit.requireFamily(db, openid);
    const members = await kit.fetchAll(db.collection('members').where({ familyId: family._id }));
    const others = members.filter((m) => m._id !== member._id);

    await db.collection('members').where({ _id: member._id }).remove();

    if (member.role === 'owner' && others.length) {
      const next = sortMembers(others)[0];
      await db.collection('members').where({ _id: next._id }).update({ data: { role: 'owner' } });
      await db.collection('families').where({ _id: family._id }).update({ data: { createdBy: next.openid } });
    }

    // 数据保留：误退可以凭邀请码重新加入，家里的记录不会丢
    return { left: true, keptData: !payload.purge, familyName: family.name };
  },

  /** 换一个邀请码（怀疑外传时用） */
  async rotateInvite(ctx) {
    const { db, openid } = ctx;
    const { member, family } = await kit.requireFamily(db, openid);
    if (member.role !== 'owner') throw kit.appError('FORBIDDEN', '只有创建者可以更换邀请码');
    const inviteCode = await uniqueInviteCode(db);
    await db.collection('families').where({ _id: family._id }).update({ data: { inviteCode } });
    return { inviteCode };
  },

  /** 彻底删除家庭及其全部数据（只有创建者、且没有其他成员时可用） */
  async destroy(ctx) {
    const { db, openid } = ctx;
    const { member, family } = await kit.requireFamily(db, openid);
    if (member.role !== 'owner') throw kit.appError('FORBIDDEN', '只有创建者可以删除家庭');
    const members = await kit.fetchAll(db.collection('members').where({ familyId: family._id }));
    if (members.length > 1) {
      throw kit.appError('NOT_EMPTY', '还有其他成员，先把他们移出家庭');
    }
    await db.collection('events').where({ familyId: family._id }).remove();
    await db.collection('items').where({ familyId: family._id }).remove();
    await db.collection('members').where({ familyId: family._id }).remove();
    await db.collection('pushLogs').where({ familyId: family._id }).remove();
    await db.collection('families').where({ _id: family._id }).remove();
    return { destroyed: true };
  },

  /** 数据导出：返回一份可保存/转发的 JSON 文本 */
  async exportData(ctx) {
    const { db, openid } = ctx;
    const { family } = await kit.requireFamily(db, openid);
    const [items, events] = await Promise.all([
      kit.fetchAll(db.collection('items').where({ familyId: family._id })),
      kit.fetchAll(db.collection('events').where({ familyId: family._id }).orderBy('occurredAt', 'asc'))
    ]);
    const payload = {
      app: 'RefillPal',
      version: 1,
      exportedAt: ctx.now,
      family: kit.publicFamily(family),
      items,
      events
    };
    return { json: JSON.stringify(payload), itemCount: items.length, eventCount: events.length };
  }
};

module.exports = {
  handlers,
  createApp: (deps) => ({ handle: kit.createHandler(handlers, deps) })
};

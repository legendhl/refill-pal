'use strict';

/**
 * notify 云函数：每天定时检查待补货，给家人推一条汇总消息。
 *
 * 为什么是这个形态：
 *   - 小程序关掉就死了，不可能后台跑代码，所以必须由云开发的定时触发器唤醒
 *   - 一次性订阅消息「一次授权只能发一条」，所以一天只发一条汇总，正好对上
 *   - 幂等键 = familyId + 当天日期，重复触发也只会推一次，绝不重复打扰
 *
 * 这个文件是纯逻辑（数据库与发送函数都是注入的），所以可以完整单测。
 */

const core = require('./shared/core');
const kit = require('./shared/kit');

/** 这些错误码意味着「不用再给这个人发了」 */
const BLOCKED_CODES = [43101];
/** 这些错误码说明模板配错了，属于开发期问题，要显式记下来 */
const TEMPLATE_ERROR_CODES = [47003, 41030];

function classify(errCode) {
  if (BLOCKED_CODES.indexOf(Number(errCode)) >= 0) return 'BLOCKED';
  if (TEMPLATE_ERROR_CODES.indexOf(Number(errCode)) >= 0) return 'TEMPLATE_ERROR';
  return 'OTHER';
}

/**
 * 给一个家庭推送。
 * 所有 early-return 都会带上 reason，方便在云函数日志里一眼看出为什么没推。
 */
async function pushFamily({ db, family, now, send }) {
  const settings = kit.settingsOf(family);
  const date = kit.dateKey(now);
  const base = { familyId: family._id, familyName: family.name, date };

  if (settings.pushEnabled === false) {
    return Object.assign(base, { pushed: false, reason: 'DISABLED' });
  }

  // 只有到了这个家庭设定的整点才推（定时器每小时醒一次）
  const wantHour = kit.pushHourOf(settings.pushTime);
  if (wantHour === null) {
    return Object.assign(base, { pushed: false, reason: 'BAD_PUSH_TIME' });
  }
  if (kit.hourOf(now) !== wantHour) {
    return Object.assign(base, { pushed: false, reason: 'NOT_YET' });
  }

  const templateId = settings.templateId;
  if (!templateId) {
    // 用户还没在小程序里点过「续订」，拿不到模板 ID
    return Object.assign(base, { pushed: false, reason: 'NO_TEMPLATE' });
  }

  // 幂等：今天已经推过就跳过
  const logged = await db.collection('pushLogs').where({ familyId: family._id, date }).limit(1).get();
  if (logged.data.length) {
    return Object.assign(base, { pushed: false, reason: 'ALREADY_PUSHED' });
  }

  const built = await kit.buildFamilyPush(db, family, now);
  if (!built.hasContent) {
    // 没有要买的就彻底安静，连日志都不写（写了也没有意义）
    return Object.assign(base, { pushed: false, reason: 'NOTHING_TO_BUY', itemCount: built.itemCount });
  }

  const members = await kit.fetchAll(db.collection('members').where({ familyId: family._id }));
  const eligible = members.filter((m) => m.subQuota && Number(m.subQuota.remaining) > 0);
  if (!eligible.length) {
    await writeLog(db, {
      familyId: family._id,
      date,
      templateId,
      payload: built.payload,
      refillCount: built.refillCount,
      results: [],
      skipped: 'NO_QUOTA',
      createdAt: now
    });
    return Object.assign(base, {
      pushed: false,
      reason: 'NO_QUOTA',
      refillCount: built.refillCount,
      memberCount: members.length
    });
  }

  const results = [];
  for (let i = 0; i < eligible.length; i += 1) {
    const member = eligible[i];
    /* eslint-disable no-await-in-loop */
    const sent = await send({
      touser: member.openid,
      templateId,
      page: 'pages/home/home',
      data: built.payload
    });
    const kind = sent.ok ? 'OK' : classify(sent.errCode);
    results.push({
      memberId: member._id,
      nickName: member.nickName || '',
      ok: Boolean(sent.ok),
      errCode: sent.errCode === undefined ? null : sent.errCode,
      errMsg: sent.errMsg || null,
      kind
    });

    if (sent.ok) {
      await updateQuota(db, member, Math.max(0, Number(member.subQuota.remaining) - 1), false);
    } else if (kind === 'BLOCKED') {
      // 用户拒收：额度清零，并在小程序里提示重新授权
      await updateQuota(db, member, 0, true);
    }
  }

  await writeLog(db, {
    familyId: family._id,
    date,
    templateId,
    payload: built.payload,
    refillCount: built.refillCount,
    results,
    skipped: null,
    createdAt: now
  });

  return Object.assign(base, {
    pushed: true,
    reason: results.some((r) => r.ok) ? 'SENT' : 'ALL_FAILED',
    refillCount: built.refillCount,
    sentCount: results.filter((r) => r.ok).length,
    results
  });
}

async function updateQuota(db, member, remaining, blocked) {
  const subQuota = Object.assign({}, member.subQuota, {
    remaining,
    blocked: Boolean(blocked),
    updatedAt: new Date()
  });
  await db.collection('members').where({ _id: member._id }).update({ data: { subQuota } });
}

async function writeLog(db, data) {
  try {
    await db.collection('pushLogs').add({ data });
  } catch (e) {
    // 唯一索引冲突说明并发跑了两遍，属于预期内的竞争，不算错误
    const msg = String((e && (e.errMsg || e.message)) || '');
    if (msg.indexOf('duplicate') < 0 && msg.indexOf('DUPLICATE') < 0) throw e;
  }
}

/** 每日总入口：遍历所有家庭 */
async function runDaily({ db, now, send }) {
  const families = await kit.fetchAll(db.collection('families'));
  const results = [];
  for (let i = 0; i < families.length; i += 1) {
    /* eslint-disable no-await-in-loop */
    try {
      results.push(await pushFamily({ db, family: families[i], now, send }));
    } catch (e) {
      results.push({
        familyId: families[i]._id,
        familyName: families[i].name,
        pushed: false,
        reason: 'ERROR',
        error: (e && e.message) || String(e)
      });
    }
  }

  const pushed = results.filter((r) => r.pushed);
  return {
    date: kit.dateKey(now),
    hour: kit.hourOf(now),
    familyCount: families.length,
    pushedCount: pushed.length,
    sentCount: pushed.reduce((s, r) => s + (r.sentCount || 0), 0),
    results
  };
}

/** 用 wx-server-sdk 的 openapi 发订阅消息 */
function createSender(cloud) {
  return async function send({ touser, templateId, page, data }) {
    try {
      const res = await cloud.openapi.subscribeMessage.send({
        touser,
        templateId,
        page,
        lang: 'zh_CN',
        miniprogramState: 'formal',
        data
      });
      return { ok: true, errCode: res && res.errCode, errMsg: res && res.errMsg };
    } catch (e) {
      return {
        ok: false,
        errCode: (e && (e.errCode || e.code)) || null,
        errMsg: (e && (e.errMsg || e.message)) || String(e)
      };
    }
  };
}

module.exports = {
  pushFamily,
  runDaily,
  createSender,
  classify,
  BLOCKED_CODES,
  TEMPLATE_ERROR_CODES
};

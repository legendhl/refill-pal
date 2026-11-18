'use strict';

/**
 * notify 云函数入口。
 *
 * 两种触发方式：
 *   1. 定时触发器（每小时整点）→ 给到了推送时间的家庭发汇总
 *   2. 小程序里手动调用 { action: 'preview' } → 只返回将要推送的内容，不发
 *      （开发期用来核对模板字段是否对上，不用等到整点）
 */

const cloud = require('wx-server-sdk');
const kit = require('./shared/server/kit');
const { runDaily, createSender } = require('./app');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const send = createSender(cloud);

/** 定时触发器传来的事件长这样：{ Type: 'Timer', TriggerName: 'dailyRefillCheck', Time: '...' } */
function isTimerEvent(event) {
  if (!event) return true;
  if (event.Type === 'Timer' || event.TriggerName) return true;
  // 没有 action 就当作定时触发（定时器传的是 {Type, TriggerName, Time}）
  return !event.action;
}

exports.main = async (event) => {
  const now = new Date();

  if (isTimerEvent(event)) {
    const summary = await runDaily({ db, now, send });
    // 总开关关着的时候每小时都会走到这里，日志只留一行，别刷屏
    if (summary.disabled) {
      console.log('[notify] 微信推送总开关已关闭（miniprogram/config.js 的 PUSH_ENABLED），跳过');
      return summary;
    }
    console.log('[notify] 每日检查完成', JSON.stringify(summary));
    return summary;
  }

  // 手动预览：只能看自己家的，不会真发消息
  const openid = (cloud.getWXContext() || {}).OPENID;
  if (!openid) {
    return { ok: false, code: 'NO_OPENID', message: '无法获取用户身份' };
  }
  try {
    const found = await kit.resolveFamily(db, openid);
    if (!found) {
      return { ok: false, code: 'NO_FAMILY', message: '你还没有加入家庭' };
    }
    const built = await kit.buildFamilyPush(db, found.family, now);
    const settings = kit.settingsOf(found.family);
    return {
      ok: true,
      data: kit.toJSON({
        hasContent: built.hasContent,
        payload: built.payload,
        refillCount: built.refillCount,
        itemCount: built.itemCount,
        pushTime: settings.pushTime,
        pushEnabled: settings.pushEnabled !== false,
        templateConfigured: Boolean(settings.templateId),
        quota: (found.member.subQuota && found.member.subQuota.remaining) || 0,
        serverTime: now
      })
    };
  } catch (e) {
    console.error('[notify] 预览失败', e && e.stack ? e.stack : e);
    return { ok: false, code: 'INTERNAL', message: '预览失败，请稍后再试' };
  }
};

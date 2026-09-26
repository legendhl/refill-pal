'use strict';

/**
 * 定时推送（notify）测试。
 *
 * 这块逻辑没法「手动试」——总不能等到明天早上 9 点看有没有收到消息。
 * 所以把数据库和发送函数都做成注入的，把一天里的各种情况全跑一遍：
 * 到点没到点、有没有内容、额度够不够、用户拒收、模板配错、重复触发。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createFakeDb, resetIdSeq } = require('../test-utils/fake-db');
const familyApp = require('../cloudfunctions/family/app');
const itemApp = require('../cloudfunctions/item/app');
const purchaseApp = require('../cloudfunctions/purchase/app');
const notify = require('../cloudfunctions/notify/app');
const kit = require('../cloudfunctions/_shared/kit');

/** 2026-09-25 01:00 UTC = 09:00 UTC+8，正好是默认推送时间 */
const PUSH_TIME = new Date(Date.UTC(2026, 8, 25, 1, 0, 0));
const EARLY = new Date(Date.UTC(2026, 8, 25, 0, 0, 0)); // 08:00 UTC+8
const NEXT_DAY = new Date(Date.UTC(2026, 8, 26, 1, 0, 0));

function ok(res) {
  assert.equal(res.ok, true, `期望成功，实际：${JSON.stringify(res)}`);
  return res.data;
}

function makeCaller(db, openid, now) {
  const deps = { db, _: db.command, getOpenId: async () => openid, now: () => now };
  const wrap = (app) => (action, payload) => app.createApp(deps).handle({ action, payload });
  return {
    family: wrap(familyApp),
    item: wrap(itemApp),
    purchase: wrap(purchaseApp)
  };
}

/** 造一个「有人有额度、有待补货、配好了模板」的家庭 */
async function setup(options = {}) {
  resetIdSeq();
  const db = createFakeDb();
  const now = options.now || PUSH_TIME;
  const dad = makeCaller(db, 'openid-dad', now);
  const mom = makeCaller(db, 'openid-mom', now);

  const created = ok(await dad.family('create', { name: '我家', nickName: '爸爸' }));
  ok(await mom.family('join', { inviteCode: created.family.inviteCode, nickName: '妈妈' }));

  if (options.withRefill !== false) {
    ok(await dad.item('create', { name: '抽纸', category: '纸品', unit: '包', baseQty: 1, initEstimateDays: 1 }));
  }
  if (options.extraItems) {
    for (let i = 0; i < options.extraItems.length; i += 1) {
      ok(await dad.item('create', options.extraItems[i]));
    }
  }

  ok(
    await dad.family('updateSettings', {
      pushEnabled: options.pushEnabled === undefined ? true : options.pushEnabled,
      pushTime: options.pushTime || '09:00',
      remindDays: 3
    })
  );

  if (options.templateId !== null) {
    const templateId = options.templateId || 'TPL-DAILY';
    const quota = options.quota === undefined ? 2 : options.quota;
    if (quota > 0) ok(await dad.family('subscribe', { count: quota, templateId }));
    if (options.momQuota) ok(await mom.family('subscribe', { count: options.momQuota, templateId }));
  }

  return { db, dad, mom, familyId: created.family._id };
}

function recorder(results) {
  const sent = [];
  let index = 0;
  const send = async (message) => {
    sent.push(message);
    if (results) {
      const r = results[Math.min(index, results.length - 1)];
      index += 1;
      return r;
    }
    return { ok: true };
  };
  return { send, sent };
}

// ============================================================ 正常路径

test('【总开关】关闭时定时任务什么都不做', async () => {
  const { db } = await setup({ quota: 2 });
  const { send, sent } = recorder();

  // 不传 enabled，用的就是模块里的总开关
  const summary = await notify.runDaily({ db, now: PUSH_TIME, send });

  assert.equal(summary.disabled, true);
  assert.equal(summary.reason, 'PUSH_DISABLED');
  assert.equal(summary.familyCount, 0, '关掉时连家庭列表都不查');
  assert.equal(sent.length, 0);
  assert.equal(db._dump('pushLogs').length, 0, '不留日志，免得以后排查时被误导');
  assert.equal(
    db._dump('members').find((m) => m.openid === 'openid-dad').subQuota.remaining,
    2,
    '不该扣额度'
  );
});

test('【总开关】客户端与云函数两处必须一致', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const configText = fs.readFileSync(
    path.join(__dirname, '..', 'miniprogram', 'config.js'),
    'utf8'
  );
  const m = /PUSH_ENABLED:\s*(true|false)/.exec(configText);
  assert.ok(m, 'miniprogram/config.js 里必须有 PUSH_ENABLED');
  assert.equal(
    m[1] === 'true',
    notify.PUSH_ENABLED,
    '只改一处会导致「界面说已打开、实际不发消息」，必须同时改'
  );
});

test('到点且有待补货 → 推一条汇总，扣一次额度，写一条日志', async () => {
  const { db } = await setup({ quota: 2 });
  const { send, sent } = recorder();

  const summary = await notify.runDaily({ db, now: PUSH_TIME, send, enabled: true });

  assert.equal(summary.familyCount, 1);
  assert.equal(summary.pushedCount, 1);
  assert.equal(summary.sentCount, 1);
  assert.equal(sent.length, 1, '只有一个成员有额度');

  const message = sent[0];
  assert.equal(message.touser, 'openid-dad');
  assert.equal(message.templateId, 'TPL-DAILY');
  assert.equal(message.page, 'pages/home/home');
  assert.ok(message.data.thing1.value.indexOf('抽纸') >= 0);
  assert.ok(message.data.thing1.value.length <= 20, '微信 thing 字段上限 20 字符');
  assert.equal(message.data.number3.value, 1);

  const members = db._dump('members');
  const dad = members.find((m) => m.openid === 'openid-dad');
  assert.equal(dad.subQuota.remaining, 1, '推送成功要扣一次额度');

  const logs = db._dump('pushLogs');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].date, '2026-09-25');
  assert.equal(logs[0].refillCount, 1);
  assert.equal(logs[0].results[0].ok, true);
  assert.equal(logs[0].results[0].kind, 'OK');
});

test('多个成员各自收到，额度各自扣', async () => {
  const { db } = await setup({ quota: 2, momQuota: 1 });
  const { send, sent } = recorder();

  const summary = await notify.runDaily({ db, now: PUSH_TIME, send, enabled: true });

  assert.equal(summary.sentCount, 2);
  assert.deepEqual(sent.map((s) => s.touser).sort(), ['openid-dad', 'openid-mom']);
  const members = db._dump('members');
  assert.equal(members.find((m) => m.openid === 'openid-dad').subQuota.remaining, 1);
  assert.equal(members.find((m) => m.openid === 'openid-mom').subQuota.remaining, 0);
});

// ============================================================ 不该推的情况

test('没到设定的时间点 → 不推、不写日志（每小时都会醒来一次）', async () => {
  const { db } = await setup();
  const { send, sent } = recorder();

  const summary = await notify.runDaily({ db, now: EARLY, send, enabled: true });

  assert.equal(summary.pushedCount, 0);
  assert.equal(summary.results[0].reason, 'NOT_YET');
  assert.equal(sent.length, 0);
  assert.equal(db._dump('pushLogs').length, 0, '没到点不该留下日志，否则当天就再也不推了');
});

test('没有需要补货的东西 → 完全不打扰，也不写日志', async () => {
  const { db } = await setup({ withRefill: false });
  const { send, sent } = recorder();

  const summary = await notify.runDaily({ db, now: PUSH_TIME, send, enabled: true });

  assert.equal(summary.results[0].reason, 'NOTHING_TO_BUY');
  assert.equal(sent.length, 0);
  assert.equal(db._dump('pushLogs').length, 0);
});

test('用户关掉了提醒 → 不推', async () => {
  const { db } = await setup({ pushEnabled: false });
  const { send, sent } = recorder();
  const summary = await notify.runDaily({ db, now: PUSH_TIME, send, enabled: true });
  assert.equal(summary.results[0].reason, 'DISABLED');
  assert.equal(sent.length, 0);
});

test('还没拿到模板 ID（用户没点过续订）→ 不推，并说明原因', async () => {
  const { db } = await setup({ templateId: null });
  const { send, sent } = recorder();
  const summary = await notify.runDaily({ db, now: PUSH_TIME, send, enabled: true });
  assert.equal(summary.results[0].reason, 'NO_TEMPLATE');
  assert.equal(sent.length, 0);
});

test('额度用完了 → 不推，但要写日志留下痕迹（方便排查为什么没收到）', async () => {
  const { db } = await setup({ quota: 1 });
  const { send, sent } = recorder();

  // 第一天把仅有的 1 次额度用掉
  const day1 = await notify.runDaily({ db, now: PUSH_TIME, send, enabled: true });
  assert.equal(day1.sentCount, 1);

  // 第二天就没额度了
  const day2 = await notify.runDaily({ db, now: NEXT_DAY, send, enabled: true });
  assert.equal(day2.results[0].reason, 'NO_QUOTA');
  assert.equal(sent.length, 1, '没额度就不能发');

  const logs = db._dump('pushLogs');
  assert.equal(logs.length, 2);
  const second = logs.find((l) => l.date === '2026-09-26');
  assert.equal(second.skipped, 'NO_QUOTA');
  assert.deepEqual(second.results, []);
  assert.ok(second.refillCount >= 1, '日志里要留下当时有几样该买，便于排查');
});

// ============================================================ 幂等

test('【幂等】同一天被触发多次，只会推一次', async () => {
  const { db } = await setup({ quota: 3 });
  const { send, sent } = recorder();

  const first = await notify.runDaily({ db, now: PUSH_TIME, send, enabled: true });
  const second = await notify.runDaily({ db, now: new Date(PUSH_TIME.getTime() + 60 * 1000), send, enabled: true });

  assert.equal(first.pushedCount, 1);
  assert.equal(second.pushedCount, 0);
  assert.equal(second.results[0].reason, 'ALREADY_PUSHED');
  assert.equal(sent.length, 1, '绝不能重复打扰');
  assert.equal(db._dump('pushLogs').length, 1);
  assert.equal(
    db._dump('members').find((m) => m.openid === 'openid-dad').subQuota.remaining,
    2,
    '也不能多扣额度'
  );
});

test('第二天可以正常推', async () => {
  const { db } = await setup({ quota: 3 });
  const { send } = recorder();

  await notify.runDaily({ db, now: PUSH_TIME, send, enabled: true });
  const day2 = await notify.runDaily({ db, now: NEXT_DAY, send, enabled: true });

  assert.equal(day2.pushedCount, 1);
  const logs = db._dump('pushLogs');
  assert.deepEqual(logs.map((l) => l.date).sort(), ['2026-09-25', '2026-09-26']);
});

// ============================================================ 失败处理

test('用户拒收（43101）→ 该成员额度清零并标记，其他人不受影响', async () => {
  const { db } = await setup({ quota: 2, momQuota: 2 });
  const { send } = recorder([{ ok: false, errCode: 43101, errMsg: 'user refuse to accept the msg' }, { ok: true }]);

  const summary = await notify.runDaily({ db, now: PUSH_TIME, send, enabled: true });

  assert.equal(summary.pushedCount, 1, '还有一个成员收到了');
  assert.equal(summary.sentCount, 1);

  const members = db._dump('members');
  const dad = members.find((m) => m.openid === 'openid-dad');
  assert.equal(dad.subQuota.remaining, 0, '拒收说明授权已失效，额度清零');
  assert.equal(dad.subQuota.blocked, true, '要标记出来，好在小程序里提示重新授权');

  const log = db._dump('pushLogs')[0];
  const failed = log.results.find((r) => !r.ok);
  assert.equal(failed.kind, 'BLOCKED');
  assert.equal(failed.errCode, 43101);
});

test('模板参数不合法（47003）→ 记录成模板错误，不能误判成用户拒收', async () => {
  const { db } = await setup({ quota: 2 });
  const { send } = recorder([{ ok: false, errCode: 47003, errMsg: 'argument invalid' }]);

  const summary = await notify.runDaily({ db, now: PUSH_TIME, send, enabled: true });

  assert.equal(summary.pushedCount, 1);
  assert.equal(summary.results[0].reason, 'ALL_FAILED');
  assert.equal(summary.results[0].sentCount, 0);

  const log = db._dump('pushLogs')[0];
  assert.equal(log.results[0].kind, 'TEMPLATE_ERROR');
  assert.equal(
    db._dump('members').find((m) => m.openid === 'openid-dad').subQuota.remaining,
    2,
    '模板配错不该扣用户额度'
  );
});

test('发送抛异常不能把整个定时任务带崩', async () => {
  const { db } = await setup({ quota: 2 });
  const send = async () => {
    throw new Error('网络断了');
  };

  const summary = await notify.runDaily({ db, now: PUSH_TIME, send, enabled: true });

  assert.equal(summary.familyCount, 1);
  assert.equal(summary.pushedCount, 0);
  assert.equal(summary.results[0].reason, 'ERROR', '单个家庭出错要被隔离成 ERROR');
  assert.match(summary.results[0].error, /网络断了/, '原因要留在日志里，否则没法排查');
});

test('一个家庭出错不影响其他家庭', async () => {
  const { db } = await setup({ quota: 2 });
  const now = PUSH_TIME;

  // 再塞一个「坏」家庭：familyId 指向不存在的成员集合也没关系，这里让它的 pushTime 非法
  db._seed('families', [
    {
      _id: 'fam-broken',
      name: '坏家庭',
      inviteCode: 'BROKEN',
      createdBy: 'openid-x',
      createdAt: now,
      settings: { remindDays: 3, pushTime: '不是时间', pushEnabled: true, templateId: 'TPL' }
    }
  ]);

  const { send, sent } = recorder();
  const summary = await notify.runDaily({ db, now, send, enabled: true });

  assert.equal(summary.familyCount, 2);
  assert.equal(summary.pushedCount, 1, '好家庭照常推送');
  assert.equal(sent.length, 1);
  const broken = summary.results.find((r) => r.familyId === 'fam-broken');
  assert.equal(broken.reason, 'BAD_PUSH_TIME');
});

// ============================================================ 时区与工具函数

test('日期与小时按 UTC+8 折算，不受云函数运行时时区影响', () => {
  assert.equal(kit.dateKey(new Date(Date.UTC(2026, 8, 24, 16, 30))), '2026-09-25');
  assert.equal(kit.dateKey(new Date(Date.UTC(2026, 8, 24, 15, 30))), '2026-09-24');
  assert.equal(kit.hourOf(new Date(Date.UTC(2026, 8, 25, 1, 0))), 9);
  assert.equal(kit.hourOf(new Date(Date.UTC(2026, 8, 25, 16, 0))), 0, '16:00Z 是次日 0 点');
});

test('pushHourOf：解析整点时间，非法值返回 null', () => {
  assert.equal(kit.pushHourOf('09:00'), 9);
  assert.equal(kit.pushHourOf('23:00'), 23);
  assert.equal(kit.pushHourOf('24:00'), null);
  assert.equal(kit.pushHourOf('9:00'), null);
  assert.equal(kit.pushHourOf(''), null);
  assert.equal(kit.pushHourOf(undefined), null);
});

test('classify：错误码分类', () => {
  assert.equal(notify.classify(43101), 'BLOCKED');
  assert.equal(notify.classify(47003), 'TEMPLATE_ERROR');
  assert.equal(notify.classify(41030), 'TEMPLATE_ERROR');
  assert.equal(notify.classify(-1), 'OTHER');
  assert.equal(notify.classify(undefined), 'OTHER');
});

test('推送文案：物品很多时截断，且带上最紧急的一条', async () => {
  const extras = ['洗手液', '洗衣液', '牙膏', '洗发水', '沐浴露', '洗洁精'].map((name) => ({
    name,
    category: '其他',
    unit: '瓶',
    baseQty: 1,
    initEstimateDays: 1
  }));
  const { db } = await setup({ quota: 1, extraItems: extras });
  const { send, sent } = recorder();

  await notify.runDaily({ db, now: PUSH_TIME, send, enabled: true });

  const payload = sent[0].data;
  assert.ok(payload.thing1.value.length <= 20);
  assert.ok(payload.thing1.value.endsWith('…'), '超长要截断而不是被微信直接拒收');
  assert.equal(payload.number3.value, 7);
  assert.ok(payload.time4.value.length > 0);
});

// ============================================================ 配置

test('notify 的定时触发器配置合法（7 位 cron，每小时整点）', () => {
  const configPath = path.join(__dirname, '..', 'cloudfunctions', 'notify', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  assert.equal(config.triggers.length, 1);
  const trigger = config.triggers[0];
  assert.equal(trigger.type, 'timer');
  const parts = trigger.config.split(' ');
  assert.equal(parts.length, 7, '微信云开发的 cron 是 7 位：秒 分 时 日 月 周 年');
  assert.equal(parts[0], '0', '秒');
  assert.equal(parts[1], '0', '分');
  assert.equal(parts[2], '*', '每小时都醒一次，由 pushTime 决定给谁推');

  assert.ok(
    config.permissions.openapi.indexOf('subscribeMessage.send') >= 0,
    '必须声明 openapi 权限，否则发不出订阅消息'
  );
});

test('notify 的 package.json 只依赖 wx-server-sdk，且不用 file: 依赖', () => {
  const pkgPath = path.join(__dirname, '..', 'cloudfunctions', 'notify', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies), ['wx-server-sdk']);
});

// ============================================================ 发送器

test('推送跳转版本可配置：体验阶段必须用 trial，否则点消息打不开', async () => {
  const calls = [];
  const fakeCloud = {
    openapi: {
      subscribeMessage: {
        send: async (params) => {
          calls.push(params);
          return {};
        }
      }
    }
  };

  await notify.createSender(fakeCloud)({ touser: 'o', templateId: 't', page: 'p', data: {} });
  assert.ok(['developer', 'trial', 'formal'].indexOf(notify.MINIPROGRAM_STATE) >= 0);
  assert.equal(calls[0].miniprogramState, notify.MINIPROGRAM_STATE);
  assert.equal(
    notify.MINIPROGRAM_STATE,
    'trial',
    '小程序还没有正式版时必须是 trial（正式发布后要改成 formal，release-check 会提醒）'
  );

  await notify.createSender(fakeCloud, { miniprogramState: 'formal' })({
    touser: 'o',
    templateId: 't',
    page: 'p',
    data: {}
  });
  assert.equal(calls[1].miniprogramState, 'formal', '要能覆盖');
});

test('发送器把 openapi 抛出的错误码原样转成结果，而不是让任务崩掉', async () => {
  const failing = {
    openapi: {
      subscribeMessage: {
        send: async () => {
          const e = new Error('user refuse to accept the msg');
          e.errCode = 43101;
          throw e;
        }
      }
    }
  };
  const res = await notify.createSender(failing)({ touser: 'o', templateId: 't', page: 'p', data: {} });
  assert.equal(res.ok, false);
  assert.equal(res.errCode, 43101);
  assert.match(res.errMsg, /refuse/);
});

// ============================================================ 订阅额度联动

test('续订时会把模板 ID 存进家庭设置，notify 靠它发消息', async () => {
  const { db, familyId } = await setup({ templateId: 'TPL-FROM-CLIENT', quota: 1 });
  const family = db._dump('families').find((f) => f._id === familyId);
  assert.equal(family.settings.templateId, 'TPL-FROM-CLIENT');
});

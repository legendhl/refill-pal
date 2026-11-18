/* 自动生成，请勿直接修改。
 * 源文件：packages/refillpal-core/src/contract/index.js
 * 由 npm run sync 同步；要改请改源文件后重新同步。
 */
'use strict';

/**
 * 契约层：所有 action 的唯一登记处。
 *
 * 存在的理由：小程序、App、服务端各自实现或消费这些 action，最容易出现
 * 「某一端多了一个字段/少了一个 action」的静默漂移。把它显式列出来，
 * 再用测试断言「登记的 action」与「实际实现的 handler」完全一致。
 */

const ACTIONS = {
  family: [
    'profile',
    'create',
    'join',
    'rename',
    'updateSettings',
    'subscribe',
    'markPushResult',
    'removeMember',
    'leave',
    'rotateInvite',
    'destroy',
    'exportData'
  ],
  item: ['list', 'detail', 'create', 'update', 'archive', 'restore', 'remove', 'stocktake', 'usedUp'],
  purchase: ['add', 'remove', 'update', 'recent', 'frequent'],
  dashboard: ['home'],
  stats: ['monthly'],
  // 下面两个只在小程序侧使用
  notify: ['preview'],
  mock: ['reset']
};

/** 需要登录（有 identity）才能调用的 action；auth 类接口不在其中 */
const AUTH_REQUIRED = true;

function listActions(fn) {
  return ACTIONS[fn] || [];
}

function allActions() {
  const out = [];
  Object.keys(ACTIONS).forEach((fn) => {
    ACTIONS[fn].forEach((action) => out.push(`${fn}.${action}`));
  });
  return out;
}

/**
 * 形状断言：只检查顶层键集合，用来防止两端返回结构漂移。
 * @returns {{ok: true} | {ok: false, missing: string[], extra: string[]}}
 */
function checkShape(actual, expectedKeys) {
  if (!actual || typeof actual !== 'object') {
    return { ok: false, missing: expectedKeys.slice(), extra: [] };
  }
  const keys = Object.keys(actual);
  const missing = expectedKeys.filter((k) => keys.indexOf(k) < 0);
  const extra = keys.filter((k) => expectedKeys.indexOf(k) < 0);
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

module.exports = { ACTIONS, AUTH_REQUIRED, listActions, allActions, checkShape };

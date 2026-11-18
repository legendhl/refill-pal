'use strict';

/**
 * 应用状态：会话 + 家庭数据 + 提醒排程。
 *
 * 刻意不依赖 React —— 这样它可以在 Node 里被完整测试（见 test/store.test.js）。
 * React 侧只需要订阅变化即可。
 */

const core = require('../core').core;
const { buildSchedule } = require('../notifications/schedule');

const INITIAL = {
  /** idle | loading | anon | ready | error */
  status: 'idle',
  user: null,
  family: null,
  members: [],
  dashboard: null,
  items: [],
  remindDays: 3,
  /** 计算好的本地通知排程 */
  schedule: [],
  error: null
};

function createStore(options) {
  const client = options.client;
  const now = options.now || (() => new Date());
  const listeners = new Set();

  const state = Object.assign({}, INITIAL);

  function getState() {
    return state;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function setState(patch) {
    Object.assign(state, patch);
    listeners.forEach((fn) => {
      try {
        fn(state);
      } catch (e) {
        /* 订阅者自己出错不该影响状态更新 */
      }
    });
    return state;
  }

  function recomputeSchedule() {
    const views = state.dashboard
      ? state.dashboard.refill.concat(state.dashboard.ok)
      : state.items;
    return buildSchedule(views, { now: now(), remindDays: state.remindDays });
  }

  /** 设为可继续使用的状态（有 token 且已拿到家庭信息） */
  function applyProfile(profile) {
    const family = profile.family || null;
    return setState({
      status: 'ready',
      user: profile.user || state.user,
      family,
      members: profile.members || [],
      error: null
    });
  }

  async function bootstrap() {
    setState({ status: 'loading', error: null });
    const token = await client.loadToken();
    if (!token) return setState({ status: 'anon', user: null, family: null });

    try {
      const me = await client.me();
      setState({ user: me.user });
      await refreshAll();
      return getState();
    } catch (e) {
      if (e.code === 'UNAUTHORIZED') {
        await client.logout();
        return setState({ status: 'anon', user: null, family: null });
      }
      return setState({ status: 'error', error: messageOf(e) });
    }
  }

  async function login(email, password) {
    setState({ status: 'loading', error: null });
    try {
      const data = await client.login({ email, password });
      setState({ user: data.user });
      await refreshAll();
      return data.user;
    } catch (e) {
      setState({ status: 'anon', error: messageOf(e) });
      throw e;
    }
  }

  async function register(email, password, nickName) {
    setState({ status: 'loading', error: null });
    try {
      const data = await client.register({ email, password, nickName });
      setState({ user: data.user });
      await refreshAll();
      return data.user;
    } catch (e) {
      setState({ status: 'anon', error: messageOf(e) });
      throw e;
    }
  }

  async function logout() {
    await client.logout();
    setState(Object.assign({}, INITIAL, { status: 'anon' }));
  }

  async function refreshAll() {
    try {
      const home = await client.call('dashboard', 'home');
      if (home && home.needOnboarding) {
        return setState({
          status: 'ready',
          family: null,
          members: [],
          dashboard: null,
          items: [],
          remindDays: 3,
          schedule: [],
          error: null
        });
      }
      const items = await client.call('item', 'list');
      setState({
        status: 'ready',
        family: home.family,
        members: home.members || [],
        dashboard: home,
        items: items.items || [],
        remindDays: home.remindDays || 3,
        error: null
      });
      return setState({ schedule: recomputeSchedule() });
    } catch (e) {
      if (e.code === 'UNAUTHORIZED') {
        await client.logout();
        return setState({ status: 'anon' });
      }
      return setState({ status: 'error', error: messageOf(e) });
    }
  }

  async function createFamily(name) {
    const data = await client.call('family', 'create', { name, nickName: state.user ? state.user.nickName : undefined });
    applyProfile({ family: data.family, members: data.members, user: state.user });
    await refreshAll();
    return data.family;
  }

  async function joinFamily(inviteCode, nickName) {
    const data = await client.call('family', 'join', { inviteCode, nickName });
    applyProfile({ family: data.family, members: data.members, user: state.user });
    await refreshAll();
    return data.family;
  }

  /** 记一笔（写完后重新拉首页，保证跨端一致） */
  async function quickAdd(itemId, qty = 1) {
    const res = await client.call('purchase', 'add', { entries: [{ itemId, qty }] });
    await refreshAll();
    return res;
  }

  async function addPurchase(itemId, qty, amount) {
    const res = await client.call('purchase', 'add', {
      entries: [{ itemId, qty, amount }]
    });
    await refreshAll();
    return res;
  }

  async function stocktake(itemId, remaining, force) {
    const res = await client.call('item', 'stocktake', { itemId, remaining, force });
    if (res && res.confirmNeeded) return res;
    await refreshAll();
    return res;
  }

  async function usedUp(itemId) {
    const res = await client.call('item', 'usedUp', { itemId });
    await refreshAll();
    return res;
  }

  /** 撤销一笔（对应小程序里的 5 秒撤销条） */
  async function removePurchase(eventIds) {
    const res = await client.call('purchase', 'remove', { eventIds });
    await refreshAll();
    return res;
  }

  async function createItem(payload) {
    const res = await client.call('item', 'create', payload);
    await refreshAll();
    return res;
  }

  async function stats(month) {
    return client.call('stats', 'monthly', month ? { month } : {});
  }

  return {
    getState,
    subscribe,
    bootstrap,
    login,
    register,
    logout,
    refreshAll,
    createFamily,
    joinFamily,
    quickAdd,
    addPurchase,
    removePurchase,
    stocktake,
    usedUp,
    createItem,
    stats,
    recomputeSchedule
  };
}

function messageOf(error) {
  return (error && error.message) || '操作失败';
}

module.exports = { createStore, INITIAL };

'use strict';

/**
 * wx API 桩：让页面 JS 能在 Node 里真跑起来。
 *
 * 只实现页面实际用到的那些 API，且行为尽量贴近真实（比如 showModal 不会
 * 自动确认，必须由测试显式排队一个回答），否则测试会掩盖交互分支。
 */

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function createWxStub() {
  const calls = {
    toast: [],
    modal: [],
    actionSheet: [],
    navigateTo: [],
    switchTab: [],
    reLaunch: [],
    navigateBack: 0,
    navigationBar: [],
    clipboard: [],
    subscribe: [],
    cloud: []
  };

  const storage = new Map();
  /** 排队中的 showModal / showActionSheet 回答 */
  const modalQueue = [];
  const sheetQueue = [];
  let pending = [];

  function track(promise) {
    if (promise && typeof promise.then === 'function') pending.push(promise);
  }

  const wx = {
    // ---- 提示与弹窗
    showToast(options = {}) {
      calls.toast.push(options);
      if (options.success) track(options.success({}));
    },
    hideToast() {},
    showLoading() {},
    hideLoading() {},
    showModal(options = {}) {
      calls.modal.push(options);
      const answer = modalQueue.length ? modalQueue.shift() : null;
      if (answer && options.success) track(options.success(Object.assign({ confirm: false, cancel: false }, answer)));
      return { confirm: () => {}, cancel: () => {} };
    },
    /** 测试用：排队下一次 showModal 的回答 */
    __queueModal(answer) {
      modalQueue.push(answer);
    },
    showActionSheet(options = {}) {
      calls.actionSheet.push(options);
      const answer = sheetQueue.length ? sheetQueue.shift() : null;
      if (answer && options.success) track(options.success(answer));
      return { tapIndex: -1 };
    },
    __queueActionSheet(answer) {
      sheetQueue.push(answer);
    },

    // ---- 存储
    setStorageSync(key, value) {
      storage.set(key, clone(value));
    },
    getStorageSync(key) {
      return storage.has(key) ? clone(storage.get(key)) : '';
    },
    removeStorageSync(key) {
      storage.delete(key);
    },
    getStorageInfoSync() {
      return { keys: Array.from(storage.keys()) };
    },
    clearStorageSync() {
      storage.clear();
    },

    // ---- 导航
    navigateTo(options = {}) {
      calls.navigateTo.push(options);
      if (options.success) track(options.success({}));
    },
    redirectTo(options = {}) {
      calls.navigateTo.push(options);
      if (options.success) track(options.success({}));
    },
    switchTab(options = {}) {
      calls.switchTab.push(options);
      if (options.success) track(options.success({}));
    },
    reLaunch(options = {}) {
      calls.reLaunch.push(options);
      if (options.success) track(options.success({}));
    },
    navigateBack() {
      calls.navigateBack += 1;
    },
    setNavigationBarTitle(options = {}) {
      calls.navigationBar.push(options);
    },
    stopPullDownRefresh() {},

    // ---- 剪贴板
    setClipboardData(options = {}) {
      calls.clipboard.push(options.data);
      if (options.success) track(options.success({}));
    },

    // ---- 订阅消息
    requestSubscribeMessage(options = {}) {
      calls.subscribe.push(options);
      const result = {};
      (options.tmplIds || []).forEach((id) => {
        result[id] = 'accept';
      });
      result.errMsg = 'requestSubscribeMessage:ok';
      if (options.success) track(options.success(result));
    },

    // ---- 杂项
    vibrateShort() {},
    getWindowInfo() {
      return { windowWidth: 375, windowHeight: 812, safeArea: { bottom: 778 } };
    },
    getSystemInfoSync() {
      return { windowWidth: 375, windowHeight: 812, platform: 'devtools' };
    },
    getCurrentPages() {
      return [{ route: 'pages/home/home' }, { route: 'pages/items/items' }];
    },
    cloud: {
      init() {},
      callFunction() {
        calls.cloud.push(arguments);
        return Promise.resolve({ result: { ok: false, code: 'NETWORK', message: '测试环境不应直连云函数' } });
      }
    }
  };

  return {
    wx,
    calls,
    storage,
    clearStorage: () => storage.clear(),
    /** 等所有被触发的异步回调跑完 */
    async flush(times = 4) {
      for (let i = 0; i < times; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const batch = pending;
        pending = [];
        await Promise.all(batch);
      }
    },
    lastToast: () => calls.toast[calls.toast.length - 1],
    lastModal: () => calls.modal[calls.modal.length - 1]
  };
}

module.exports = { createWxStub };

/**
 * 云函数调用封装。
 *
 * 统一返回 { ok, data, code, message }，页面里只需要判断 ok，
 * 不需要关心是走了云函数还是走了演示数据（mock）。
 */

const config = require('../config');

let mockLayer = null;

function init(options = {}) {
  const useMock = options.useMock === undefined ? config.USE_MOCK : Boolean(options.useMock);
  if (useMock) {
    // 延迟加载：真实模式下不把演示数据打进包
    mockLayer = require('./mock');
    mockLayer.init({ latency: options.latency });
  } else {
    mockLayer = null;
  }
  return { useMock };
}

function isMock() {
  return Boolean(mockLayer);
}

/**
 * 调云端。name 是云函数名，action 是 app.js 里的 handler 名。
 * 网络异常也转成 { ok:false }，让页面只需要处理一种返回形态。
 */
async function call(name, action, payload) {
  if (mockLayer) {
    return mockLayer.call(name, action, payload);
  }
  try {
    const res = await wx.cloud.callFunction({
      name,
      data: { action, payload: payload || {} }
    });
    const result = res && res.result;
    if (!result || typeof result !== 'object') {
      return { ok: false, code: 'EMPTY_RESULT', message: '服务没有返回数据，请重试' };
    }
    return result;
  } catch (e) {
    const msg = (e && (e.errMsg || e.message)) || '';
    // 云函数不存在最常见的原因是还没上传，这里给出可执行的提示
    if (/FunctionName parameter could not be found|not found/i.test(msg)) {
      return { ok: false, code: 'NO_FUNCTION', message: `云函数 ${name} 还没部署，先看 docs/deploy.md` };
    }
    return { ok: false, code: 'NETWORK', message: '网络不太顺，稍后再试' };
  }
}

/** 成功则返回 data，失败则抛错（错误对象带 code，便于页面提示） */
async function callOrThrow(name, action, payload) {
  const res = await call(name, action, payload);
  if (res && res.ok) return res.data;
  const err = new Error((res && res.message) || '操作失败');
  err.code = (res && res.code) || 'UNKNOWN';
  throw err;
}

/** 页面通用加载器：把 call 的失败统一弹提示 */
function showError(err) {
  const msg = (err && err.message) || '操作失败，稍后再试';
  wx.showToast({ title: msg, icon: 'none', duration: 2600 });
}

module.exports = {
  init,
  isMock,
  call,
  callOrThrow,
  showError
};

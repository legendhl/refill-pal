'use strict';

/**
 * API 客户端：把服务端的 `{ ok, data } / { ok:false, code, message }`
 * 统一成「成功返回 data，失败抛 ApiError(code)」。
 *
 * 只依赖 fetch，所以可以在 Node 里用假 fetch 完整测试。
 */

class ApiError extends Error {
  constructor(code, message, status) {
    super(message || '操作失败');
    this.name = 'ApiError';
    this.code = code || 'UNKNOWN';
    this.status = status || 0;
  }
}

function joinUrl(baseUrl, path) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}${path}`;
}

/**
 * @param {object} options
 * @param {string} options.baseUrl      形如 https://api.example.com
 * @param {function} [options.fetchImpl] 注入用（测试）
 * @param {string} [options.token]      初始 token
 * @param {{get:function,set:function,clear:function}} [options.tokenStore] 持久化
 */
function createClient(options = {}) {
  const baseUrl = options.baseUrl || '';
  const fetchImpl = options.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const tokenStore = options.tokenStore || null;
  let token = options.token || null;

  if (!fetchImpl) throw new Error('当前运行环境没有 fetch');

  async function setToken(next) {
    token = next || null;
    if (tokenStore) {
      if (token) await tokenStore.set(token);
      else await tokenStore.clear();
    }
    return token;
  }

  async function loadToken() {
    if (token) return token;
    if (tokenStore) token = await tokenStore.get();
    return token;
  }

  async function request(method, path, body) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const current = token || (tokenStore ? await tokenStore.get() : null);
    if (current) headers.authorization = `Bearer ${current}`;

    let res;
    try {
      res = await fetchImpl(joinUrl(baseUrl, path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) {
      throw new ApiError('NETWORK', '连不上服务器，检查网络后再试', 0);
    }

    let payload = null;
    try {
      payload = await res.json();
    } catch (e) {
      payload = null;
    }

    if (!payload || typeof payload !== 'object') {
      throw new ApiError('BAD_RESPONSE', `服务返回异常（HTTP ${res.status}）`, res.status);
    }
    if (!payload.ok) {
      throw new ApiError(payload.code, payload.message, res.status);
    }
    return payload.data;
  }

  return {
    setToken,
    loadToken,
    getToken: () => token,

    async register({ email, password, nickName }) {
      const data = await request('POST', '/api/auth/register', { email, password, nickName });
      await setToken(data.token);
      return data;
    },

    async login({ email, password }) {
      const data = await request('POST', '/api/auth/login', { email, password });
      await setToken(data.token);
      return data;
    },

    async logout() {
      await setToken(null);
    },

    me() {
      return request('GET', '/api/auth/me');
    },

    /**
     * 业务调用：与服务端/云函数同一套 `{fn}.{action}` 契约。
     * @param {string} fn      例如 'item'
     * @param {string} action  例如 'list'
     */
    call(fn, action, payload = {}) {
      return request('POST', `/api/${encodeURIComponent(fn)}/${encodeURIComponent(action)}`, payload);
    },

    health() {
      return request('GET', '/api/health');
    }
  };
}

module.exports = { createClient, ApiError, joinUrl };

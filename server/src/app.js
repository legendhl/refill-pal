'use strict';

/**
 * HTTP 层：一个零依赖的极简服务器（node:http）。
 *
 * 设计要点：
 *   - 业务逻辑不在这里，全部委托给 packages/refillpal-core 的 handlers，
 *     与小程序的云函数共用同一份实现；
 *   - 身份由 JWT 解析成 `user:<id>`，再注入 handler 的 getOpenId —— 这正是
 *     设计文档 §5.1 说的那个「身份接缝」；
 *   - 返回结构保持 `{ ok, data } / { ok:false, code, message }`，与小程序一致，
 *     这样客户端的 api 封装可以复用同一套判断。
 */

const http = require('node:http');

const MAX_BODY_BYTES = 1024 * 1024;

/** 业务错误码 → HTTP 状态码 */
const STATUS_BY_CODE = {
  UNAUTHORIZED: 401,
  BAD_CREDENTIALS: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ITEM_NOT_FOUND: 404,
  EVENT_NOT_FOUND: 404,
  MEMBER_NOT_FOUND: 404,
  INVALID_INPUT: 400,
  INVALID_EMAIL: 400,
  INVALID_PASSWORD: 400,
  INVALID_CODE: 400,
  UNKNOWN_ACTION: 400,
  DUPLICATE_NAME: 409,
  ALREADY_IN_FAMILY: 409,
  EMAIL_TAKEN: 409,
  NO_FAMILY: 409,
  NOT_EMPTY: 409,
  INTERNAL: 500
};

function statusOf(code) {
  return STATUS_BY_CODE[code] || 400;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体太大'), { code: 'PAYLOAD_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'INVALID_JSON' }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  res.writeHead(
    status,
    Object.assign(
      {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store'
      },
      extraHeaders || {}
    )
  );
  res.end(body);
}

/**
 * @param {object} options
 * @param {object} options.repo       SQLite repository
 * @param {object} options.auth       createAuth() 的产物
 * @param {object} options.handlers   { family: module, ... }
 * @param {function} [options.now]
 * @param {function} [options.log]
 * @param {string} [options.corsOrigin]
 */
function createApp(options) {
  const { repo, auth, handlers } = options;
  const now = options.now || (() => new Date());
  const log = options.log || (() => {});
  const corsOrigin = options.corsOrigin === undefined ? '*' : options.corsOrigin;

  function corsHeaders() {
    return {
      'access-control-allow-origin': corsOrigin,
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-max-age': '86400'
    };
  }

  async function handleApi(fn, action, req) {
    const mod = handlers[fn];
    if (!mod) return { status: 404, body: { ok: false, code: 'NOT_FOUND', message: `没有这个接口：${fn}` } };

    const authed = await auth.authenticate(req.headers.authorization);
    if (!authed) {
      return { status: 401, body: { ok: false, code: 'UNAUTHORIZED', message: '请先登录' } };
    }

    const payload = await readBody(req);
    const app = mod.createApp({
      db: repo,
      _: repo.command,
      getOpenId: async () => authed.identity,
      now
    });
    const result = await app.handle({ action, payload });

    if (result && result.ok) {
      return { status: 200, body: result };
    }
    return {
      status: statusOf(result && result.code),
      body: result || { ok: false, code: 'INTERNAL', message: '服务异常' }
    };
  }

  async function route(req) {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method.toUpperCase();

    if (method === 'OPTIONS') return { status: 204, body: null };
    if (parts[0] !== 'api') return { status: 404, body: { ok: false, code: 'NOT_FOUND', message: '路径不存在' } };

    // GET /api/health
    if (parts[1] === 'health' && method === 'GET') {
      return {
        status: 200,
        body: { ok: true, data: { status: 'ok', time: now().toISOString() } }
      };
    }

    if (parts[1] === 'auth') {
      if (parts[2] === 'register' && method === 'POST') {
        const body = await readBody(req);
        try {
          const data = await auth.register(body || {});
          return { status: 201, body: { ok: true, data } };
        } catch (e) {
          return { status: statusOf(e.code), body: { ok: false, code: e.code || 'INTERNAL', message: e.message } };
        }
      }
      if (parts[2] === 'login' && method === 'POST') {
        const body = await readBody(req);
        try {
          const data = await auth.login(body || {});
          return { status: 200, body: { ok: true, data } };
        } catch (e) {
          return { status: statusOf(e.code), body: { ok: false, code: e.code || 'INTERNAL', message: e.message } };
        }
      }
      if (parts[2] === 'me' && method === 'GET') {
        const authed = await auth.authenticate(req.headers.authorization);
        if (!authed) {
          return { status: 401, body: { ok: false, code: 'UNAUTHORIZED', message: '请先登录' } };
        }
        const found = await require('../../packages/refillpal-core/src/server/kit').resolveFamily(
          repo,
          authed.identity
        );
        return {
          status: 200,
          body: {
            ok: true,
            data: {
              user: auth.publicUser(authed.user),
              identity: authed.identity,
              family: found ? { familyId: found.family._id, role: found.member.role } : null
            }
          }
        };
      }
      return { status: 404, body: { ok: false, code: 'NOT_FOUND', message: '路径不存在' } };
    }

    // POST /api/<fn>/<action>
    if (parts.length >= 3 && method === 'POST') {
      return handleApi(parts[1], parts[2], req);
    }
    if (parts.length >= 3) {
      return { status: 405, body: { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只支持 POST' } };
    }
    return { status: 404, body: { ok: false, code: 'NOT_FOUND', message: '路径不存在' } };
  }

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    let result;
    try {
      result = await route(req);
    } catch (e) {
      const code = e && e.code;
      if (code === 'INVALID_JSON' || code === 'PAYLOAD_TOO_LARGE') {
        result = { status: 400, body: { ok: false, code, message: e.message } };
      } else {
        log('error', 'unhandled', { url: req.url, error: (e && e.stack) || String(e) });
        result = { status: 500, body: { ok: false, code: 'INTERNAL', message: '服务开小差了' } };
      }
    }

    log('info', `${req.method} ${req.url}`, { status: result.status, ms: Date.now() - startedAt });

    if (result.status === 204) {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, corsHeaders());
  });

  return { server, route };
}

module.exports = { createApp, STATUS_BY_CODE, MAX_BODY_BYTES };

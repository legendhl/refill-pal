'use strict';

/**
 * 极简 JWT（HS256），只依赖 node:crypto。
 *
 * 只实现我们自己用得到的部分：签发、校验、过期判断。
 * 不支持的算法一律拒绝（防止 alg=none 之类的降级攻击）。
 */

const crypto = require('node:crypto');

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function fromB64url(input) {
  return Buffer.from(String(input), 'base64url').toString('utf8');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function sign(payload, secret, ttlSeconds) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(
    JSON.stringify(Object.assign({}, payload, { iat: now, exp: now + Number(ttlSeconds || 0) }))
  );
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verify(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;

  let header;
  try {
    header = JSON.parse(fromB64url(parts[0]));
  } catch (e) {
    return null;
  }
  if (!header || header.alg !== 'HS256') return null;

  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  if (!safeEqual(expected, parts[2])) return null;

  let payload;
  try {
    payload = JSON.parse(fromB64url(parts[1]));
  } catch (e) {
    return null;
  }
  if (!payload || !payload.exp) return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}

/** 从 Authorization 头里取出 Bearer token */
function parseBearer(headerValue) {
  const m = /^Bearer\s+(.+)$/i.exec(String(headerValue || '').trim());
  return m ? m[1].trim() : null;
}

module.exports = { sign, verify, parseBearer };

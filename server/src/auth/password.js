'use strict';

/**
 * 密码哈希：scrypt（Node 内置，零依赖）。
 *
 * 存储格式：scrypt$N$r$p$salt(base64)$hash(base64)
 * 参数写进字符串里，将来调参时老密码仍能校验。
 *
 * 明确不做：明文、MD5、SHA1、可逆加密。
 */

const crypto = require('node:crypto');

const DEFAULT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;
const MAX_MEM = 64 * 1024 * 1024;

function hashPassword(password, params = DEFAULT_PARAMS) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAX_MEM
  });
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    hash.toString('base64')
  ].join('$');
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (!expected.length) return false;

  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length, {
      N,
      r,
      p,
      maxmem: MAX_MEM
    });
  } catch (e) {
    return false;
  }

  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

module.exports = { hashPassword, verifyPassword, DEFAULT_PARAMS };

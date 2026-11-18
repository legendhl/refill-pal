'use strict';

/**
 * 账号服务：注册、登录、按 token 还原用户。
 *
 * 与业务 handler 的分工：
 *   - 这里是「谁是调用者」，产物是一个 identity 字符串 `user:<id>`；
 *   - 业务 handler 只认 identity，不关心它来自邮箱密码还是微信。
 *
 * 刻意不做：邮箱验证、找回密码（见设计文档 §11.7 —— 先省掉发邮件这个外部依赖）。
 */

const { hashPassword, verifyPassword } = require('./password');
const token = require('./token');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 72;

class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function createAuth({ repo, secret, ttlSeconds = 30 * 24 * 60 * 60, now = () => new Date() }) {
  function identityOf(user) {
    return `user:${user._id}`;
  }

  async function findByEmail(email) {
    const res = await repo.collection('users').where({ email }).limit(1).get();
    return res.data[0] || null;
  }

  async function findById(id) {
    const res = await repo.collection('users').where({ _id: id }).limit(1).get();
    return res.data[0] || null;
  }

  function validateCredentials({ email, password }) {
    const mail = normalizeEmail(email);
    if (!EMAIL_RE.test(mail)) throw new AuthError('INVALID_EMAIL', '邮箱格式不对');
    if (typeof password !== 'string') throw new AuthError('INVALID_PASSWORD', '密码不能为空');
    if (password.length < MIN_PASSWORD) {
      throw new AuthError('INVALID_PASSWORD', `密码至少 ${MIN_PASSWORD} 位`);
    }
    if (password.length > MAX_PASSWORD) {
      throw new AuthError('INVALID_PASSWORD', `密码最长 ${MAX_PASSWORD} 位`);
    }
    return { email: mail, password };
  }

  async function register({ email, password, nickName }) {
    const cred = validateCredentials({ email, password });
    if (await findByEmail(cred.email)) {
      throw new AuthError('EMAIL_TAKEN', '这个邮箱已经注册过了');
    }

    const doc = {
      email: cred.email,
      passwordHash: hashPassword(cred.password),
      nickName: String(nickName || '').trim().slice(0, 20) || cred.email.split('@')[0],
      createdAt: now()
    };
    const { _id } = await repo.collection('users').add({ data: doc });
    doc._id = _id;

    return {
      user: publicUser(doc),
      identity: identityOf(doc),
      token: token.sign({ sub: _id }, secret, ttlSeconds),
      expiresIn: ttlSeconds
    };
  }

  async function login({ email, password }) {
    const cred = validateCredentials({ email, password });
    const user = await findByEmail(cred.email);
    // 用户不存在与密码错误返回同一个错误，避免被用来枚举邮箱
    if (!user || !verifyPassword(cred.password, user.passwordHash)) {
      throw new AuthError('BAD_CREDENTIALS', '邮箱或密码不对');
    }
    return {
      user: publicUser(user),
      identity: identityOf(user),
      token: token.sign({ sub: user._id }, secret, ttlSeconds),
      expiresIn: ttlSeconds
    };
  }

  /** 校验 Authorization 头，返回 { user, identity }；失败返回 null */
  async function authenticate(authorizationHeader) {
    const raw = token.parseBearer(authorizationHeader);
    if (!raw) return null;
    const payload = token.verify(raw, secret);
    if (!payload || !payload.sub) return null;
    const user = await findById(payload.sub);
    if (!user) return null;
    return { user, identity: identityOf(user) };
  }

  return { register, login, authenticate, identityOf, publicUser };
}

function publicUser(user) {
  return {
    _id: user._id,
    email: user.email,
    nickName: user.nickName || '',
    createdAt: user.createdAt
  };
}

module.exports = { createAuth, AuthError, publicUser, normalizeEmail, MIN_PASSWORD };

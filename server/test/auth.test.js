'use strict';

/** 账号体系：密码哈希、注册登录、token 校验 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSqliteRepo } = require('../src/db/sqlite-repo');
const { createAuth } = require('../src/auth/service');
const { hashPassword, verifyPassword } = require('../src/auth/password');
const token = require('../src/auth/token');

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

function setup(ttlSeconds = 3600) {
  const repo = createSqliteRepo({ file: ':memory:' });
  const auth = createAuth({ repo, secret: SECRET, ttlSeconds });
  return { repo, auth };
}

test('密码哈希：格式可识别，校验通过，错误密码拒绝', () => {
  const stored = hashPassword('correct horse battery');
  assert.match(stored, /^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/);
  assert.equal(verifyPassword('correct horse battery', stored), true);
  assert.equal(verifyPassword('wrong password', stored), false);
});

test('密码哈希：同一密码两次结果不同（盐随机），但都能校验', () => {
  const a = hashPassword('same-password');
  const b = hashPassword('same-password');
  assert.notEqual(a, b);
  assert.equal(verifyPassword('same-password', a), true);
  assert.equal(verifyPassword('same-password', b), true);
});

test('密码校验：脏数据不崩，直接判失败', () => {
  assert.equal(verifyPassword('x', ''), false);
  assert.equal(verifyPassword('x', 'md5$abc'), false);
  assert.equal(verifyPassword('x', 'scrypt$bad$8$1$aaaa$bbbb'), false);
  assert.equal(verifyPassword('x', null), false);
});

test('注册：返回 token 与 identity，且不下发密码哈希', async () => {
  const { repo, auth } = setup();
  const out = await auth.register({ email: 'Dad@Example.com', password: 'password123', nickName: '爸爸' });

  assert.equal(out.user.email, 'dad@example.com', '邮箱要归一化');
  assert.equal(out.user.nickName, '爸爸');
  assert.equal(out.user.passwordHash, undefined, '不能把哈希返回给客户端');
  assert.equal(out.identity, `user:${out.user._id}`);
  assert.ok(out.token);

  const stored = (await repo.collection('users').where({ email: 'dad@example.com' }).get()).data[0];
  assert.match(stored.passwordHash, /^scrypt\$/);
  repo.close();
});

test('注册：重复邮箱被拒绝，且错误码可区分', async () => {
  const { repo, auth } = setup();
  await auth.register({ email: 'a@b.com', password: 'password123' });
  await assert.rejects(
    () => auth.register({ email: 'a@b.com', password: 'password123' }),
    (e) => e.code === 'EMAIL_TAKEN'
  );
  repo.close();
});

test('注册：邮箱格式与密码长度校验', async () => {
  const { repo, auth } = setup();
  await assert.rejects(() => auth.register({ email: 'not-an-email', password: 'password123' }), (e) => e.code === 'INVALID_EMAIL');
  await assert.rejects(() => auth.register({ email: 'a@b.com', password: 'short' }), (e) => e.code === 'INVALID_PASSWORD');
  repo.close();
});

test('登录：正确密码通过，错误密码与不存在邮箱返回同一个错误', async () => {
  const { repo, auth } = setup();
  await auth.register({ email: 'a@b.com', password: 'password123' });

  const ok = await auth.login({ email: 'a@b.com', password: 'password123' });
  assert.ok(ok.token);
  assert.equal(ok.identity.indexOf('user:'), 0);

  await assert.rejects(
    () => auth.login({ email: 'a@b.com', password: 'wrong-password' }),
    (e) => e.code === 'BAD_CREDENTIALS'
  );
  await assert.rejects(
    () => auth.login({ email: 'nobody@b.com', password: 'password123' }),
    (e) => e.code === 'BAD_CREDENTIALS'
  );
  repo.close();
});

test('token：能校验，篡改即失效', async () => {
  const { repo, auth } = setup();
  const out = await auth.register({ email: 'a@b.com', password: 'password123' });

  const authed = await auth.authenticate(`Bearer ${out.token}`);
  assert.ok(authed);
  assert.equal(authed.user.email, 'a@b.com');

  const tampered = out.token.slice(0, -3) + 'abc';
  assert.equal(await auth.authenticate(`Bearer ${tampered}`), null);

  assert.equal(await auth.authenticate(''), null);
  assert.equal(await auth.authenticate('Bearer garbage'), null);
  repo.close();
});

test('token：过期后失效', async () => {
  const { repo, auth } = setup(-10); // 签发即过期
  const out = await auth.register({ email: 'a@b.com', password: 'password123' });
  assert.equal(await auth.authenticate(`Bearer ${out.token}`), null);
  repo.close();
});

test('token：拒绝 alg=none 之类的降级伪造', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: 'x', exp: Math.floor(Date.now() / 1000) + 999 })).toString('base64url');
  assert.equal(token.verify(`${header}.${body}.`, SECRET), null);
});

test('parseBearer：大小写与空白都能容忍', () => {
  assert.equal(token.parseBearer('Bearer abc'), 'abc');
  assert.equal(token.parseBearer('bearer   abc  '), 'abc');
  assert.equal(token.parseBearer('Basic abc'), null);
  assert.equal(token.parseBearer(undefined), null);
});

'use strict';

/**
 * 契约测试：登记在 contract 里的 action 必须与真实实现的 handler 完全一致。
 *
 * 这一层是为了防止"某一端悄悄多了/少了一个 action"——服务端、云函数、
 * App 都靠这份登记表对齐，漂移了必须立刻失败。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const contract = require('../src/contract');
const pkg = require('../src');

const SERVER_HANDLERS = {
  family: require('../src/server/handlers/family'),
  item: require('../src/server/handlers/item'),
  purchase: require('../src/server/handlers/purchase'),
  dashboard: require('../src/server/handlers/dashboard'),
  stats: require('../src/server/handlers/stats')
};

test('每个服务端 handler 模块都导出 handlers 与 createApp', () => {
  Object.keys(SERVER_HANDLERS).forEach((name) => {
    const mod = SERVER_HANDLERS[name];
    assert.equal(typeof mod.handlers, 'object', `${name} 缺少 handlers`);
    assert.equal(typeof mod.createApp, 'function', `${name} 缺少 createApp`);
  });
});

test('契约登记的 action 与实现的 handler 一一对应（不多不少）', () => {
  Object.keys(SERVER_HANDLERS).forEach((name) => {
    const declared = contract.listActions(name).slice().sort();
    const implemented = Object.keys(SERVER_HANDLERS[name].handlers).sort();
    assert.deepEqual(implemented, declared, `${name} 的 action 与契约不一致`);
  });
});

test('契约覆盖了所有服务端模块', () => {
  Object.keys(SERVER_HANDLERS).forEach((name) => {
    assert.ok(contract.listActions(name).length > 0, `契约里没有登记 ${name}`);
  });
});

test('包入口只暴露客户端可用的东西（不含服务端 kit / handlers）', () => {
  assert.ok(pkg.core, '缺少 core');
  assert.ok(pkg.view, '缺少 view');
  assert.ok(pkg.format, '缺少 format');
  assert.ok(pkg.constants, '缺少 constants');
  assert.ok(pkg.contract, '缺少 contract');
  assert.equal(pkg.kit, undefined, 'serve 端 kit 不该从入口导出，否则会打进 App 包');
  assert.equal(pkg.handlers, undefined, 'handlers 不该从入口导出');
});

test('包入口的 core 就是算法模块本体', () => {
  const direct = require('../src/algorithms/core');
  assert.equal(typeof pkg.core.buildItemView, 'function');
  assert.equal(typeof direct.buildItemView, 'function');
});

test('checkShape 能发现字段缺失与多余', () => {
  const ok = contract.checkShape({ a: 1, b: 2 }, ['a', 'b']);
  assert.equal(ok.ok, true);

  const missing = contract.checkShape({ a: 1 }, ['a', 'b']);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['b']);

  const extra = contract.checkShape({ a: 1, b: 2, c: 3 }, ['a', 'b']);
  assert.equal(extra.ok, false);
  assert.deepEqual(extra.extra, ['c']);
});

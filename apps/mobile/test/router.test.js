'use strict';

/** 导航栈：推入/返回/替换，以及订阅通知 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRouter } = require('../src/navigation/router');

test('初始状态只有一个路由，且不能返回', () => {
  const router = createRouter({ name: 'home' });
  assert.equal(router.current().name, 'home');
  assert.equal(router.canGoBack(), false);
  assert.equal(router.pop().name, 'home', '已在根部时 pop 不崩');
});

test('push / pop 维护栈顺序', () => {
  const router = createRouter({ name: 'home' });
  router.push({ name: 'item', params: { id: 'a' } });
  router.push({ name: 'edit' });

  assert.equal(router.current().name, 'edit');
  assert.equal(router.canGoBack(), true);

  assert.equal(router.pop().name, 'item');
  assert.equal(router.pop().name, 'home');
});

test('replace 替换栈顶，reset 清空栈', () => {
  const router = createRouter({ name: 'home' });
  router.push({ name: 'item' });
  router.replace({ name: 'detail' });
  assert.equal(router.get().length, 2);
  assert.equal(router.current().name, 'detail');

  router.reset({ name: 'login' });
  assert.equal(router.get().length, 1);
  assert.equal(router.current().name, 'login');
});

test('订阅者能收到变化，取消订阅后不再收到', () => {
  const router = createRouter({ name: 'home' });
  const seen = [];
  const off = router.subscribe((stack) => seen.push(stack.length));

  router.push({ name: 'item' });
  router.pop();
  assert.deepEqual(seen, [2, 1]);

  off();
  router.push({ name: 'item' });
  assert.deepEqual(seen, [2, 1]);
});

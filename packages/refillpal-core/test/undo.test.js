'use strict';

/** 撤销窗口队列测试（定时器用虚拟时钟注入，不依赖真实时间） */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createUndoQueue } = require('../src/view/undo');

/** 虚拟时钟：手动推进时间，按到期顺序触发定时器 */
function makeClock() {
  let time = 0;
  let seq = 0;
  let timers = [];
  return {
    now: () => time,
    setTimer: (fn, ms) => {
      seq += 1;
      const t = { id: seq, fn, at: time + ms };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      timers = timers.filter((x) => x.id !== t.id);
    },
    advance: (ms) => {
      const target = time + ms;
      for (let guard = 0; guard < 100; guard += 1) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at);
        if (!due.length) break;
        const t = due[0];
        timers = timers.filter((x) => x.id !== t.id);
        time = t.at;
        t.fn();
      }
      time = target;
      return time;
    },
    pendingCount: () => timers.length
  };
}

function setup(windowMs = 5000) {
  const clock = makeClock();
  const expired = [];
  const queue = createUndoQueue({
    windowMs,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onExpire: (id) => expired.push(id)
  });
  return { clock, queue, expired };
}

test('窗口内撤销成功，过期回调不触发', () => {
  const { clock, queue, expired } = setup(5000);
  queue.push('ev-1', { label: '抽纸 ×1' });
  assert.equal(queue.has('ev-1'), true);

  clock.advance(3000);
  const undone = queue.undo('ev-1');
  assert.ok(undone, '3 秒时应该还能撤销');
  assert.equal(undone.meta.label, '抽纸 ×1');
  assert.equal(queue.has('ev-1'), false);

  clock.advance(10000);
  assert.deepEqual(expired, [], '撤销之后不该再触发过期回调');
});

test('超过窗口后撤销失败，且过期回调被触发一次', () => {
  const { clock, queue, expired } = setup(5000);
  queue.push('ev-2');

  clock.advance(4999);
  assert.equal(queue.has('ev-2'), true, '4.999 秒时仍在窗口内');

  clock.advance(2);
  assert.equal(queue.has('ev-2'), false, '超过 5 秒后应出队');
  assert.deepEqual(expired, ['ev-2']);
  assert.equal(queue.undo('ev-2'), null, '过期后撤销应返回 null');
});

test('边界：恰好到窗口时刻即过期', () => {
  const { clock, queue, expired } = setup(5000);
  queue.push('ev-3');
  clock.advance(5000);
  assert.deepEqual(expired, ['ev-3']);
  assert.equal(queue.undo('ev-3'), null);
});

test('撤销不存在的 id 返回 null，不抛异常', () => {
  const { queue } = setup();
  assert.equal(queue.undo('不存在'), null);
  assert.equal(queue.has('不存在'), false);
});

test('连续记多笔时各自独立计时，可以只撤销其中一笔', () => {
  const { clock, queue, expired } = setup(5000);
  queue.push('ev-a');
  clock.advance(2000);
  queue.push('ev-b');
  assert.deepEqual(queue.ids().sort(), ['ev-a', 'ev-b']);
  assert.equal(queue.size(), 2);

  clock.advance(3500); // ev-a 满 5.5 秒过期，ev-b 才 3.5 秒
  assert.deepEqual(expired, ['ev-a']);
  assert.equal(queue.has('ev-b'), true);

  assert.ok(queue.undo('ev-b'));
  assert.equal(queue.size(), 0);
});

test('重复 push 同一个 id 会重置计时', () => {
  const { clock, queue, expired } = setup(5000);
  queue.push('ev-x');
  clock.advance(4000);
  queue.push('ev-x');
  clock.advance(2000); // 距第二次 push 只有 2 秒
  assert.deepEqual(expired, []);
  assert.equal(queue.has('ev-x'), true);
  assert.equal(queue.size(), 1);
});

test('clear：离开页面时清空队列并取消定时器', () => {
  const { clock, queue, expired } = setup(5000);
  queue.push('ev-1');
  queue.push('ev-2');
  queue.clear();
  assert.equal(queue.size(), 0);
  assert.equal(clock.pendingCount(), 0, '定时器也要清掉，否则会泄漏');
  clock.advance(10000);
  assert.deepEqual(expired, []);
});

test('空 id 不入队，避免把无效记录当成可撤销', () => {
  const { queue } = setup();
  assert.equal(queue.push(''), null);
  assert.equal(queue.push(null), null);
  assert.equal(queue.size(), 0);
});

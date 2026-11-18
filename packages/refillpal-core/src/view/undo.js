/** 撤销窗口队列（纯逻辑，定时器可注入，便于单测） */

/**
 * 「记一笔」后给用户 5 秒反悔时间。
 * 记录其实已经写入云端了，撤销=删掉刚写的那条流水，
 * 所以这里只负责「还来不来得及撤销」，不做任何网络请求。
 */
function createUndoQueue(options = {}) {
  const windowMs = options.windowMs || 5000;
  const now = options.now || (() => Date.now());
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const onExpire = options.onExpire || (() => {});

  const pending = new Map();

  function push(id, meta = {}) {
    if (!id) return null;
    if (pending.has(id)) cancel(id);
    const entry = {
      id,
      meta,
      pushedAt: now(),
      expiresAt: now() + windowMs,
      timer: null
    };
    entry.timer = setTimer(() => {
      pending.delete(id);
      onExpire(id, meta);
    }, windowMs);
    pending.set(id, entry);
    return entry;
  }

  function cancel(id) {
    const entry = pending.get(id);
    if (!entry) return null;
    if (entry.timer) clearTimer(entry.timer);
    pending.delete(id);
    return entry;
  }

  /** 撤销：返回被撤销的条目，不在队列里则返回 null（表示已经过期） */
  function undo(id) {
    return cancel(id);
  }

  function has(id) {
    return pending.has(id);
  }

  function ids() {
    return Array.from(pending.keys());
  }

  function size() {
    return pending.size;
  }

  function clear() {
    pending.forEach((entry) => {
      if (entry.timer) clearTimer(entry.timer);
    });
    pending.clear();
  }

  return { push, undo, has, ids, size, clear, windowMs };
}

module.exports = { createUndoQueue };

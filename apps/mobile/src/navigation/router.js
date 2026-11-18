'use strict';

/**
 * 极简导航栈（零依赖）。只有 5 个页面，用不着引入 react-navigation；
 * 将来页面变多再替换，路由数据形状保持不变。
 */

function createRouter(initial) {
  let stack = [initial];
  const listeners = new Set();

  function emit() {
    listeners.forEach((fn) => fn(stack));
  }

  return {
    get: () => stack,
    current: () => stack[stack.length - 1],
    canGoBack: () => stack.length > 1,
    push(route) {
      stack = stack.concat([route]);
      emit();
      return route;
    },
    pop() {
      if (stack.length <= 1) return stack[0];
      stack = stack.slice(0, -1);
      emit();
      return stack[stack.length - 1];
    },
    replace(route) {
      stack = stack.slice(0, -1).concat([route]);
      emit();
      return route;
    },
    reset(route) {
      stack = [route];
      emit();
      return route;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}

module.exports = { createRouter };

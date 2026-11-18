'use strict';

const { useState, useEffect } = require('react');

/** 订阅 store 的 React hook（store 本身与框架无关，见 state/store.js） */
function useStore(store) {
  const [state, setState] = useState(store.getState());
  useEffect(() => store.subscribe(setState), [store]);
  return state;
}

module.exports = { useStore };

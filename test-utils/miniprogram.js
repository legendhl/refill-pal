'use strict';

/**
 * 极简小程序页面运行时：把 Page()/Component() 注册的配置变成一个可调用的实例，
 * 并实现 setData（含 'a.b.c' 路径写法）。这样页面逻辑可以在 Node 里被真正执行。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/** 支持 setData({ 'form.name': 'x' }) 这种路径写法 */
function applyPatch(target, patch) {
  Object.keys(patch || {}).forEach((key) => {
    if (key.indexOf('.') < 0 && key.indexOf('[') < 0) {
      target[key] = patch[key];
      return;
    }
    const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
    let cursor = target;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (cursor[part] === undefined || cursor[part] === null) {
        cursor[part] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      }
      cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = patch[key];
  });
}

let captured = null;

/**
 * 加载并实例化一个页面/组件。
 * @param {string} relPath 形如 'pages/home/home'
 */
function loadPage(relPath, options = {}) {
  const file = path.join(MP, `${relPath}.js`);
  if (!fs.existsSync(file)) throw new Error(`找不到页面: ${file}`);

  global.wx = options.wx;
  global.getApp = () => options.app || { globalData: {}, ready: async () => null };
  const capture = (config) => {
    captured = config;
  };
  global.Page = capture;
  global.Component = capture;
  // 小程序里 getCurrentPages / getApp 都是全局函数
  global.getCurrentPages = () => options.pages || [{ route: 'pages/home/home' }, { route: 'pages/items/items' }];

  delete require.cache[require.resolve(file)];
  captured = null;
  require(file);
  if (!captured) throw new Error(`${relPath} 没有调用 Page()/Component()`);

  const config = captured;
  const instance = Object.create(null);
  Object.keys(config).forEach((key) => {
    if (key === 'data' || key === 'methods') return;
    instance[key] = config[key];
  });
  // 组件的事件处理函数写在 methods 里
  if (config.methods) {
    Object.keys(config.methods).forEach((key) => {
      instance[key] = config.methods[key];
    });
  }
  instance.data = clone(config.data) || {};

  // 组件 properties 的默认值并入 data，方便断言
  if (config.properties) {
    Object.keys(config.properties).forEach((key) => {
      const def = config.properties[key];
      if (instance.data[key] === undefined) {
        instance.data[key] = def && typeof def === 'object' && 'value' in def ? def.value : def;
      }
    });
  }

  instance.setData = function setData(patch, callback) {
    applyPatch(this.data, patch || {});
    if (typeof callback === 'function') callback();
  };
  instance.triggerEvent = function triggerEvent() {};
  instance.selectComponent = () => null;

  // 真实运行时 onLoad 一定会被调用（无参数时是 {}），所以这里也总是调用
  if (typeof instance.onLoad === 'function') {
    instance.onLoad(options.query || {});
  }

  return instance;
}

/** 从 WXML 里抽出所有事件绑定处理函数名 */
function wxmlHandlers(relPath) {
  const file = path.join(MP, `${relPath}.wxml`);
  const source = fs.readFileSync(file, 'utf8');
  const names = new Set();
  const re = /\b(?:bind|catch):?([a-zA-Z]+)\s*=\s*"([^"{}]+)"/g;
  let m = re.exec(source);
  while (m) {
    names.add(m[2].trim());
    m = re.exec(source);
  }
  return names;
}

/** 从 WXML 里抽出所有 {{}} 表达式的根标识符（跳过字符串字面量与属性访问） */
function wxmlIdentifiers(relPath) {
  const file = path.join(MP, `${relPath}.wxml`);
  const source = fs.readFileSync(file, 'utf8');
  const ids = new Set();
  const re = /\{\{([\s\S]*?)\}\}/g;
  let m = re.exec(source);
  while (m) {
    const expr = m[1]
      .replace(/'[^']*'/g, "''")
      .replace(/"[^"]*"/g, '""');
    const idRe = /(^|[^.\w$])([A-Za-z_$][A-Za-z0-9_$]*)/g;
    let idm = idRe.exec(expr);
    while (idm) {
      ids.add(idm[2]);
      idm = idRe.exec(expr);
    }
    m = re.exec(source);
  }
  return ids;
}

/** WXML 里声明的 wx:for 别名（这些名字由框架提供，不是页面数据） */
function wxmlLoopAliases(relPath) {
  const file = path.join(MP, `${relPath}.wxml`);
  const source = fs.readFileSync(file, 'utf8');
  const aliases = new Set(['item', 'index']);
  const re = /wx:for-(?:item|index)\s*=\s*"([^"]+)"/g;
  let m = re.exec(source);
  while (m) {
    aliases.add(m[1]);
    m = re.exec(source);
  }
  return aliases;
}

/** 页面 JS 里 setData 用到的字面量键（动态键无法静态分析） */
function setDataKeys(relPath) {
  const file = path.join(MP, `${relPath}.js`);
  const source = fs.readFileSync(file, 'utf8');
  const keys = new Set();
  const re = /setData\(\s*\{([\s\S]*?)\}\s*[,)]/g;
  let m = re.exec(source);
  while (m) {
    const body = m[1];
    const keyRe = /(?:^|[,{\s])(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][A-Za-z0-9_$]*))\s*:/g;
    let km = keyRe.exec(body);
    while (km) {
      keys.add(km[1] || km[2] || km[3]);
      km = keyRe.exec(body);
    }
    m = re.exec(source);
  }
  return keys;
}

module.exports = {
  ROOT,
  MP,
  loadPage,
  wxmlHandlers,
  wxmlIdentifiers,
  wxmlLoopAliases,
  setDataKeys,
  applyPatch
};

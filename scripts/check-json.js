'use strict';

/**
 * 静态结构校验。没有云环境时，这是除单测之外唯一能自动发现
 * 「路径写错、页面漏建、组件不存在、云函数缺文件」的手段。
 *
 * 用法：node scripts/check-json.js
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');
const CF = path.join(ROOT, 'cloudfunctions');

const errors = [];
const warnings = [];
const notes = [];

function fail(msg) {
  errors.push(msg);
}
function warn(msg) {
  warnings.push(msg);
}

function walk(dir, filter, out = []) {
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    if (entry.name === 'node_modules' || entry.name === '.git') return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, filter, out);
    } else if (filter(full)) {
      out.push(full);
    }
  });
  return out;
}

// ---------------------------------------------------- 1. 所有 JSON 可解析

const jsonFiles = walk(ROOT, (f) => f.endsWith('.json'));
jsonFiles.forEach((file) => {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`JSON 解析失败: ${path.relative(ROOT, file)} → ${e.message}`);
  }
});
notes.push(`检查了 ${jsonFiles.length} 个 JSON 文件`);

// ---------------------------------------------------- 2. app.json 页面完整性

const appJsonPath = path.join(MP, 'app.json');
if (!fs.existsSync(appJsonPath)) {
  fail('缺少 miniprogram/app.json');
}

let appJson = { pages: [] };
try {
  appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
} catch (e) {
  /* 已在第 1 步报错 */
}

const pages = appJson.pages || [];
pages.forEach((p) => {
  ['.js', '.json', '.wxml'].forEach((ext) => {
    const file = path.join(MP, `${p}${ext}`);
    if (!fs.existsSync(file)) fail(`页面文件缺失: miniprogram/${p}${ext}`);
  });
});

// 反向检查：磁盘上有页面目录但没注册进 app.json
const pageDirs = fs.existsSync(path.join(MP, 'pages'))
  ? fs.readdirSync(path.join(MP, 'pages'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  : [];
pageDirs.forEach((name) => {
  if (pages.indexOf(`pages/${name}/${name}`) < 0) {
    warn(`miniprogram/pages/${name} 目录存在但未注册到 app.json 的 pages`);
  }
});

// ---------------------------------------------------- 3. tabBar 一致性

const tabList = (appJson.tabBar && appJson.tabBar.list) || [];
tabList.forEach((tab) => {
  if (pages.indexOf(tab.pagePath) < 0) {
    fail(`tabBar 的 ${tab.pagePath} 不在 app.json pages 列表中`);
  }
});
notes.push(`app.json 注册 ${pages.length} 个页面，tabBar ${tabList.length} 项`);

// ---------------------------------------------------- 4. 组件路径可达

const pageJsons = walk(MP, (f) => f.endsWith('.json') && f !== appJsonPath);
let componentRefs = 0;
pageJsons.forEach((file) => {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return;
  }
  const using = json.usingComponents || {};
  Object.keys(using).forEach((tag) => {
    componentRefs += 1;
    const raw = using[tag];
    if (typeof raw !== 'string' || !raw) {
      fail(`${path.relative(ROOT, file)} 的组件 ${tag} 路径为空`);
      return;
    }
    const base = raw.startsWith('/') ? path.join(MP, raw) : path.resolve(path.dirname(file), raw);
    ['.js', '.json', '.wxml'].forEach((ext) => {
      if (!fs.existsSync(`${base}${ext}`)) {
        fail(`${path.relative(ROOT, file)} 引用的组件 ${tag} 缺少文件: ${path.relative(ROOT, base)}${ext}`);
      }
    });
  });
});
notes.push(`检查了 ${componentRefs} 个组件引用`);

// ---------------------------------------------------- 5. 云函数结构完整性

const sharedSrc = path.join(CF, '_shared', 'core.js');
const sharedSource = fs.existsSync(sharedSrc) ? fs.readFileSync(sharedSrc, 'utf8') : null;
if (!sharedSource) fail('缺少 cloudfunctions/_shared/core.js');

const cfDirs = fs.existsSync(CF)
  ? fs.readdirSync(CF, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
      .map((d) => d.name)
  : [];

if (!cfDirs.length) warn('cloudfunctions 下还没有任何云函数目录');

cfDirs.forEach((name) => {
  const dir = path.join(CF, name);
  ['index.js', 'package.json'].forEach((f) => {
    if (!fs.existsSync(path.join(dir, f))) fail(`云函数 ${name} 缺少 ${f}`);
  });
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (!pkg.dependencies || !pkg.dependencies['wx-server-sdk']) {
        fail(`云函数 ${name} 的 package.json 未声明 wx-server-sdk 依赖`);
      }
      if (pkg.dependencies && pkg.dependencies['wx-server-sdk'] && String(pkg.dependencies['wx-server-sdk']).indexOf('file:') === 0) {
        fail(`云函数 ${name} 使用了 file: 依赖，会导致开发者工具上传失败`);
      }
    } catch (e) {
      /* 已报错 */
    }
  }
  // 定时触发器与 openapi 权限：写错了不会报错，只会「静默不触发」，所以静态查一遍
  const cfgPath = path.join(dir, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      (cfg.triggers || []).forEach((trigger, i) => {
        if (trigger.type !== 'timer') {
          fail(`云函数 ${name} 的触发器 #${i + 1} 类型应为 timer，实际 ${trigger.type}`);
          return;
        }
        const fields = String(trigger.config || '').trim().split(/\s+/);
        if (fields.length !== 7) {
          fail(`云函数 ${name} 的定时 cron 必须是 7 位（秒 分 时 日 月 周 年），实际 ${fields.length} 位：${trigger.config}`);
        }
      });
      if (cfg.permissions && cfg.permissions.openapi && !Array.isArray(cfg.permissions.openapi)) {
        fail(`云函数 ${name} 的 permissions.openapi 必须是数组`);
      }
    } catch (e) {
      fail(`云函数 ${name} 的 config.json 解析失败: ${e.message}`);
    }
  }

  const sharedCopy = path.join(dir, 'shared', 'core.js');
  if (!fs.existsSync(sharedCopy)) {
    fail(`云函数 ${name} 缺少 shared/core.js，请先运行 npm run sync`);
  } else if (sharedSource && fs.readFileSync(sharedCopy, 'utf8') !== sharedSource) {
    fail(`云函数 ${name}/shared/core.js 与 _shared/core.js 不一致，请运行 npm run sync`);
  }
});
notes.push(`检查了 ${cfDirs.length} 个云函数`);

// ---------------------------------------------------- 6. 所有 JS 语法可编译

const jsFiles = walk(ROOT, (f) => f.endsWith('.js') && f.indexOf('node_modules') < 0);
let syntaxChecked = 0;
jsFiles.forEach((file) => {
  const source = fs.readFileSync(file, 'utf8');
  try {
    // 只编译不执行：能抓出语法错误、括号不配、误用保留字等
    // eslint-disable-next-line no-new
    new vm.Script(source, { filename: file });
    syntaxChecked += 1;
  } catch (e) {
    fail(`JS 语法错误: ${path.relative(ROOT, file)} → ${e.message}`);
  }
});
notes.push(`编译检查了 ${syntaxChecked} 个 JS 文件`);

// ---------------------------------------------------- 6.5 WXML 标签配对

/**
 * 极简 WXML 结构检查：标签必须成对闭合。
 * 少一个 </view> 在开发者工具里是编译错误，但只有打开工具才看得到，
 * 所以这里静态查一遍。属性值里可能出现 >（如 wx:if="{{a > b}}"），
 * 所以扫描时要跳过引号内的内容。
 */
function checkWxmlBalance(source) {
  const problems = [];
  const stack = [];
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) break;
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    let j = lt + 1;
    let quote = null;
    while (j < source.length) {
      const ch = source[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j += 1;
    }
    if (j >= source.length) {
      problems.push('有标签没有闭合的 ">"');
      break;
    }
    const raw = source.slice(lt + 1, j).trim();
    i = j + 1;
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      const top = stack.pop();
      if (top !== name) problems.push(`</${name}> 与最近的开标签 <${top || '无'}> 不匹配`);
    } else if (!raw.endsWith('/')) {
      const name = raw.split(/[\s]/)[0];
      if (name) stack.push(name);
    }
  }
  if (stack.length) problems.push(`标签没有闭合：${stack.join(' > ')}`);
  return problems;
}

const wxmlFiles = walk(MP, (f) => f.endsWith('.wxml'));
wxmlFiles.forEach((file) => {
  const problems = checkWxmlBalance(fs.readFileSync(file, 'utf8'));
  problems.forEach((p) => fail(`WXML 结构问题 ${path.relative(ROOT, file)}: ${p}`));
});
notes.push(`检查了 ${wxmlFiles.length} 个 WXML 的标签配对`);

// ---------------------------------------------------- 7. 部署占位符是否还留着

const configPath = path.join(MP, 'config.js');
if (!fs.existsSync(configPath)) {
  fail('缺少 miniprogram/config.js');
} else {
  const configText = fs.readFileSync(configPath, 'utf8');
  if (configText.indexOf('YOUR-CLOUD-ENV-ID') >= 0) {
    warn('miniprogram/config.js 的 ENV_ID 仍是占位符（部署前必须替换）');
  }
  if (configText.indexOf('YOUR-SUBSCRIBE-TEMPLATE-ID') >= 0) {
    warn('miniprogram/config.js 的 SUBSCRIBE_TEMPLATE_ID 仍是占位符（部署前必须替换）');
  }
  if (/USE_MOCK:\s*true/.test(configText)) {
    warn('USE_MOCK 仍为 true，云函数部署完成后需要改成 false');
  }
}

const projectConfigPath = path.join(ROOT, 'project.config.json');
if (fs.existsSync(projectConfigPath)) {
  const pc = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8'));
  if (String(pc.appid || '').indexOf('YOUR_APPID') >= 0) {
    warn('project.config.json 的 appid 仍是占位符（部署前必须替换）');
  }
}

// ---------------------------------------------------- 输出

console.log('');
notes.forEach((n) => console.log(`  · ${n}`));
console.log('');

warnings.forEach((w) => console.log(`  ⚠ ${w}`));
if (warnings.length) console.log('');

if (errors.length) {
  errors.forEach((e) => console.log(`  ✗ ${e}`));
  console.log(`\n结构校验失败：${errors.length} 个错误，${warnings.length} 个提醒\n`);
  process.exit(1);
}

console.log(`  ✓ 结构校验通过（${warnings.length} 个提醒）\n`);

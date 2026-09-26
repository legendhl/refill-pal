'use strict';

/**
 * 发布前自检：把「必须在发布前改掉、但很容易忘」的东西一次性查出来。
 *
 *   node scripts/release-check.js        # 只检查
 *   node scripts/release-check.js --check-only
 *
 * 与 check-json.js 的分工：
 *   check-json.js  管「代码/结构对不对」（每次提交都该过）
 *   release-check  管「这个包能不能发给用户」（只在要上传体验版/提审前跑）
 *
 * 未通过时退出码为 1，所以也可以挂在 CI 上。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');
const CF = path.join(ROOT, 'cloudfunctions');

const blockers = [];
const reminders = [];
const passed = [];

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function flag(text, name) {
  const m = new RegExp(`${name}\\s*:\\s*(true|false)`).exec(text);
  return m ? m[1] === 'true' : null;
}

// ---------------------------------------------------- 1. 演示模式必须关掉

const config = read(path.join(MP, 'config.js'));
if (flag(config, 'USE_MOCK') === true) {
  blockers.push(
    'USE_MOCK 还是 true：审核员和家人都只会看到本机演示数据，云端根本没被使用。改成 false。'
  );
} else {
  passed.push('USE_MOCK 已关闭（走真实云函数）');
}

// ---------------------------------------------------- 2. 占位符必须换掉

const projectConfig = read(path.join(ROOT, 'project.config.json'));
if (/YOUR_APPID/.test(projectConfig)) {
  blockers.push('project.config.json 的 appid 还是占位符，换成你自己的小程序 AppID。');
} else {
  passed.push('AppID 已填写');
}

if (/YOUR-CLOUD-ENV-ID/.test(config)) {
  blockers.push('miniprogram/config.js 的 ENV_ID 还是占位符，云函数一个都调不通。');
} else {
  passed.push('云开发环境 ID 已填写');
}

// ---------------------------------------------------- 3. 推送配置一致性

const notifyApp = read(path.join(CF, 'notify', 'app.js'));
const pushClient = flag(config, 'PUSH_ENABLED');
const pushCloudMatch = /const PUSH_ENABLED\s*=\s*(true|false)/.exec(notifyApp);
const pushCloud = pushCloudMatch ? pushCloudMatch[1] === 'true' : null;
const stateMatch = /const MINIPROGRAM_STATE\s*=\s*'([^']+)'/.exec(notifyApp);
const mpState = stateMatch ? stateMatch[1] : null;

if (pushClient === null || pushCloud === null) {
  blockers.push('找不到 PUSH_ENABLED（客户端 config.js 或 notify/app.js）。');
} else if (pushClient !== pushCloud) {
  blockers.push(
    `推送总开关两处不一致：config.js=${pushClient}，notify/app.js=${pushCloud}。会出现「界面说已打开、实际不发」。`
  );
} else if (pushClient === true) {
  if (/YOUR-SUBSCRIBE-TEMPLATE-ID/.test(config)) {
    blockers.push('推送已打开但 SUBSCRIBE_TEMPLATE_ID 还是占位符，消息发不出去。');
  } else {
    passed.push('推送已打开且模板 ID 已填写');
  }
  if (mpState !== 'formal') {
    reminders.push(
      `推送总开关是打开的，但 MINIPROGRAM_STATE 是 '${mpState}'（不是正式版）。` +
        '体验阶段这样是对的；**正式发布后要改成 formal**，否则用户点消息打不开。'
    );
  }
} else {
  passed.push('推送总开关已关闭（微信推送功能不出现）');
  if (mpState !== 'trial' && mpState !== 'developer') {
    reminders.push(
      `推送总开关关闭时 MINIPROGRAM_STATE 建议保持 'trial'，当前是 '${mpState}'。`
    );
  }
}

// ---------------------------------------------------- 4. 云函数目录完整性

const expectedFunctions = ['family', 'item', 'purchase', 'dashboard', 'stats', 'notify'];
const missing = expectedFunctions.filter((name) => !fs.existsSync(path.join(CF, name, 'index.js')));
if (missing.length) {
  blockers.push(`云函数目录不完整：缺 ${missing.join('、')}`);
} else {
  const stale = expectedFunctions.filter((name) => {
    const copy = path.join(CF, name, 'shared', 'core.js');
    const source = path.join(CF, '_shared', 'core.js');
    return !fs.existsSync(copy) || fs.readFileSync(copy, 'utf8') !== fs.readFileSync(source, 'utf8');
  });
  if (stale.length) {
    blockers.push(`这些云函数的 shared/ 与 _shared/ 不一致，先在根目录跑 npm run sync：${stale.join('、')}`);
  } else {
    passed.push(`6 个云函数齐全，且共享代码已同步`);
  }
}

// ---------------------------------------------------- 5. 主包体积

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    const full = path.join(dir, entry.name);
    if (entry.name === 'node_modules') return sum;
    if (entry.isDirectory()) return sum + dirSize(full);
    return sum + fs.statSync(full).size;
  }, 0);
}

const sizeKB = Math.round(dirSize(MP) / 1024);
if (sizeKB > 1800) {
  blockers.push(`主包 ${sizeKB}KB，接近或超过微信 2MB 上限，需要压缩图片或分包。`);
} else {
  passed.push(`主包体积 ${sizeKB}KB（上限 2048KB）`);
}

// ---------------------------------------------------- 6. 审核观感

const reviewRisk = [];
if (/docs\/deploy\.md|USE_MOCK|PUSH_ENABLED|演示模式/.test(read(path.join(MP, 'pages', 'me', 'me.wxml')))) {
  reviewRisk.push('「我的」页有开发向文案，但这些都挂在 isMock/未配置判断下，USE_MOCK=false 时不会显示');
}
const onboarding = read(path.join(MP, 'pages', 'onboarding', 'onboarding.js'));
if (/PAL123/.test(onboarding)) {
  reviewRisk.push('引导页里的示例邀请码只出现在演示模式的「直接体验」入口，真实模式不可达');
}

// ---------------------------------------------------- 输出

console.log('\n发布前自检\n');

passed.forEach((p) => console.log(`  ✓ ${p}`));
if (reminders.length) {
  console.log('');
  reminders.forEach((r) => console.log(`  ⚠ ${r}`));
}
if (reviewRisk.length) {
  console.log('');
  reviewRisk.forEach((r) => console.log(`  · ${r}`));
}

if (blockers.length) {
  console.log('\n必须先解决：');
  blockers.forEach((b) => console.log(`  ✗ ${b}`));
  console.log(`\n${blockers.length} 项待处理，现在还不适合上传体验版或提审。\n`);
  process.exit(1);
}

console.log('\n自检通过：这个包可以上传体验版 / 提交审核了。\n');
console.log('还差平台侧的动作（代码查不出来）：');
console.log('  · 云开发控制台：把 notify / dashboard / stats 的超时时间调到 20 秒以上');
console.log('  · 数据库：5 个集合的权限都设为「仅管理端可读写」，索引按 docs/deploy.md 建好');
console.log('  · 公众平台：服务类目、用户隐私保护指引（需要声明相册写入权限）');
console.log('  · 公众平台：小程序备案（不影响真机测试，但影响发布，建议尽早提交）');
console.log('  · 成员管理：把家人加为体验成员\n');

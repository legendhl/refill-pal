'use strict';

/**
 * 把 cloudfunctions/_shared/*.js 复制到各云函数的 shared/ 下。
 *
 * 为什么不用 npm 的 file: 本地依赖：微信开发者工具上传云函数时对
 * node_modules 里的软链接处理不可靠，会导致上传后 require 失败。
 * 复制虽然土，但每次上传前跑一次就一定对。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CF_DIR = path.join(ROOT, 'cloudfunctions');
const SHARED_DIR = path.join(CF_DIR, '_shared');

function main() {
  if (!fs.existsSync(SHARED_DIR)) {
    console.error(`[sync-shared] 找不到源目录: ${SHARED_DIR}`);
    process.exit(1);
  }
  const sources = fs
    .readdirSync(SHARED_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.js'))
    .map((d) => d.name);

  if (!sources.length) {
    console.error('[sync-shared] _shared 下没有任何 .js 文件');
    process.exit(1);
  }

  const targets = fs
    .readdirSync(CF_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(CF_DIR, name, 'index.js')));

  if (!targets.length) {
    console.error('[sync-shared] 没有找到任何云函数目录（需要含 index.js）');
    process.exit(1);
  }

  let written = 0;
  let checked = 0;
  targets.forEach((name) => {
    const dir = path.join(CF_DIR, name, 'shared');
    fs.mkdirSync(dir, { recursive: true });
    sources.forEach((file) => {
      const source = fs.readFileSync(path.join(SHARED_DIR, file), 'utf8');
      const dest = path.join(dir, file);
      checked += 1;
      const current = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
      if (current !== source) {
        fs.writeFileSync(dest, source);
        written += 1;
        console.log(`[sync-shared] 更新 cloudfunctions/${name}/shared/${file}`);
      }
    });
  });

  console.log(
    `[sync-shared] 完成：${targets.length} 个云函数 × ${sources.length} 个共享文件，` +
      `共 ${checked} 个文件${written ? `，更新了 ${written} 个` : '，全部已是最新'}`
  );

  // core.js 额外复制一份到小程序端：**只给 utils/mock.js 用**（演示模式没有服务端，
  // 只能在小程序里算）。这样演示模式与真实云端是同一套算法，不会出现两套行为。
  const mpCore = path.join(ROOT, 'miniprogram', 'utils', 'core.js');
  const coreSource = fs.readFileSync(path.join(SHARED_DIR, 'core.js'), 'utf8');
  const banner =
    '/* 由 scripts/sync-shared.js 自动生成，请勿直接修改。\n' +
    ' * 源文件：cloudfunctions/_shared/core.js\n' +
    ' * 小程序端仅 utils/mock.js（演示模式）使用；真实模式下库存一律由云端算好下发。\n' +
    ' */\n';
  const wanted = banner + coreSource;
  const mpCurrent = fs.existsSync(mpCore) ? fs.readFileSync(mpCore, 'utf8') : null;
  if (mpCurrent !== wanted) {
    fs.mkdirSync(path.dirname(mpCore), { recursive: true });
    fs.writeFileSync(mpCore, wanted);
    console.log('[sync-shared] 更新 miniprogram/utils/core.js（仅供演示模式使用）');
  }
}

main();

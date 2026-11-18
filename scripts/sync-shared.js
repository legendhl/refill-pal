'use strict';

/**
 * 把 packages/refillpal-core/src 的单一份源，同步到两个「没法直接引用它」的消费方：
 *
 *   1. 云函数：微信云函数上传时必须是自包含目录，路径不能指向项目根之外，
 *      且 npm file: 依赖在开发者工具里不可靠 —— 所以整棵 src 树复制进
 *      cloudfunctions/<fn>/shared/，保持相对路径不变（require 不用改）。
 *   2. 小程序：miniprogramRoot 之外的文件无法 require —— 所以 view/* 与
 *      algorithms/core.js 复制进 miniprogram/utils/。
 *
 * 小程序里多一层铺垫是因为它需要「扁平」目录（utils/viewmodel.js 而不是
 * utils/view/viewmodel.js），所以单独处理。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'packages', 'refillpal-core', 'src');
const CF = path.join(ROOT, 'cloudfunctions');
const MP_UTILS = path.join(ROOT, 'miniprogram', 'utils');

/** 生成文件的头注释，让人一眼看出不该手改 */
function banner(relPath) {
  return (
    '/* 自动生成，请勿直接修改。\n' +
    ` * 源文件：packages/refillpal-core/src/${relPath}\n` +
    ' * 由 npm run sync 同步；要改请改源文件后重新同步。\n' +
    ' */\n'
  );
}

function walkJs(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJs(full, base, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(path.relative(base, full));
    }
  });
  return out;
}

function readSource(relPath) {
  return fs.readFileSync(path.join(SRC, relPath), 'utf8');
}

/** 云函数需要同步的目录（含 index.js 的那些） */
function cloudFunctionDirs() {
  return fs
    .readdirSync(CF, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(CF, name, 'index.js')));
}

/**
 * 期望生成的全部文件：{ dest, rel, content }
 * check-json.js 会拿这个列表反过来校验「生成物是不是最新」。
 */
function expectedCopies() {
  const srcFiles = walkJs(SRC);
  const copies = [];

  cloudFunctionDirs().forEach((fn) => {
    srcFiles.forEach((rel) => {
      copies.push({
        dest: path.join(CF, fn, 'shared', rel),
        rel: `${fn}/shared/${rel}`,
        content: banner(rel) + readSource(rel)
      });
    });
  });

  // 小程序端：扁平拷贝，只搬客户端用得上的
  const flat = [
    ['algorithms/core.js', 'core.js'],
    ['view/viewmodel.js', 'viewmodel.js'],
    ['view/format.js', 'format.js'],
    ['view/constants.js', 'constants.js'],
    ['view/undo.js', 'undo.js']
  ];
  flat.forEach(([rel, as]) => {
    copies.push({
      dest: path.join(MP_UTILS, as),
      rel: `miniprogram/utils/${as}`,
      content: banner(rel) + readSource(rel)
    });
  });

  return copies;
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`[sync] 找不到源目录：${SRC}`);
    process.exit(1);
  }

  const copies = expectedCopies();
  let written = 0;

  // 云函数的 shared/ 是纯生成目录，先清掉避免残留已删除的文件
  cloudFunctionDirs().forEach((fn) => {
    fs.rmSync(path.join(CF, fn, 'shared'), { recursive: true, force: true });
  });

  copies.forEach(({ dest, rel, content }) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const current = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
    if (current !== content) {
      fs.writeFileSync(dest, content);
      written += 1;
      console.log(`[sync] 更新 ${rel}`);
    }
  });

  console.log(
    `[sync] 完成：${cloudFunctionDirs().length} 个云函数 + 小程序，共 ${copies.length} 个文件` +
      (written ? `，更新 ${written} 个` : '，全部已是最新')
  );
}

if (require.main === module) main();

module.exports = { expectedCopies, cloudFunctionDirs, SRC, banner };

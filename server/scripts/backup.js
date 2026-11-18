'use strict';

/**
 * 备份脚本：用 SQLite 的 VACUUM INTO 生成一份一致的快照。
 *
 * 为什么不用 `cp`：WAL 模式下直接拷贝主库文件可能漏掉尚未 checkpoint 的
 * 事务，拷出来的库可能不一致。VACUUM INTO 会写入一份自洽的完整副本。
 *
 * 用法：
 *   node server/scripts/backup.js [输出目录]
 *   DB_FILE=/var/lib/refillpal/refillpal.db node server/scripts/backup.js /var/backups/refillpal
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function stamp(date) {
  const d = date || new Date();
  const p = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * @param {object} options
 * @param {string} options.dbFile
 * @param {string} options.outDir
 * @param {Date} [options.now]
 * @returns {string} 备份文件路径
 */
function backup(options) {
  const dbFile = options.dbFile;
  const outDir = options.outDir;
  if (!fs.existsSync(dbFile)) throw new Error(`找不到数据库：${dbFile}`);

  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, `refillpal-${stamp(options.now)}.db`);

  const db = new DatabaseSync(dbFile, { readOnly: false });
  try {
    // VACUUM INTO 要求目标文件不存在
    if (fs.existsSync(target)) fs.unlinkSync(target);
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  const size = fs.statSync(target).size;
  if (!size) throw new Error('备份文件为空，可能失败了');
  return target;
}

/** 删除超过 keepDays 的备份 */
function prune(outDir, keepDays, now) {
  if (!fs.existsSync(outDir)) return [];
  const cutoff = (now || new Date()).getTime() - keepDays * 24 * 60 * 60 * 1000;
  const removed = [];
  fs.readdirSync(outDir)
    .filter((f) => /^refillpal-\d{8}-\d{4}\.db$/.test(f))
    .forEach((f) => {
      const full = path.join(outDir, f);
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed.push(f);
      }
    });
  return removed;
}

if (require.main === module) {
  const outDir = process.argv[2] || path.join(process.cwd(), 'backups');
  const dbFile = process.env.DB_FILE || path.join(process.cwd(), 'data', 'refillpal.db');
  try {
    const target = backup({ dbFile, outDir });
    const removed = prune(outDir, 30);
    console.log(`[backup] 已生成 ${target}（${(fs.statSync(target).size / 1024).toFixed(1)} KB）`);
    if (removed.length) console.log(`[backup] 清理了 ${removed.length} 个超过 30 天的备份`);
  } catch (e) {
    console.error(`[backup] 失败：${e.message}`);
    process.exit(1);
  }
}

module.exports = { backup, prune, stamp };

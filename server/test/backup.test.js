'use strict';

/** 备份必须「可恢复」才算备份：这里真的把备份打开读一遍 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSqliteRepo } = require('../src/db/sqlite-repo');
const { backup, prune } = require('../scripts/backup');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'refillpal-backup-'));
}

test('备份出来的库能打开，且数据完整', async () => {
  const dir = tmpDir();
  const dbFile = path.join(dir, 'refillpal.db');
  const repo = createSqliteRepo({ file: dbFile });

  await repo.collection('items').add({ data: { familyId: 'f1', name: '抽纸', baseQty: 2 } });
  await repo.collection('events').add({ data: { familyId: 'f1', qty: 1, occurredAt: new Date() } });
  repo.close();

  const target = backup({ dbFile, outDir: path.join(dir, 'backups') });
  assert.ok(fs.existsSync(target));

  // 用备份库重新打开，验证数据真的在里面
  const restored = createSqliteRepo({ file: target });
  assert.equal((await restored.collection('items').count()).total, 1);
  const item = (await restored.collection('items').where({ name: '抽纸' }).get()).data[0];
  assert.equal(item.baseQty, 2);
  assert.equal((await restored.collection('events').count()).total, 1);
  restored.close();

  fs.rmSync(dir, { recursive: true, force: true });
});

test('备份可重复执行，文件名带时间戳不冲突', () => {
  const dir = tmpDir();
  const dbFile = path.join(dir, 'refillpal.db');
  createSqliteRepo({ file: dbFile }).close();

  const a = backup({ dbFile, outDir: path.join(dir, 'b'), now: new Date('2026-09-25T03:10:00') });
  const b = backup({ dbFile, outDir: path.join(dir, 'b'), now: new Date('2026-09-26T03:10:00') });
  assert.notEqual(a, b);
  assert.match(path.basename(a), /^refillpal-20260925-0310\.db$/);
  assert.match(path.basename(b), /^refillpal-20260926-0310\.db$/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('prune 只删超过保留期的备份', () => {
  const dir = tmpDir();
  const outDir = path.join(dir, 'b');
  fs.mkdirSync(outDir, { recursive: true });

  const old = path.join(outDir, 'refillpal-20200101-0300.db');
  const fresh = path.join(outDir, 'refillpal-20260925-0300.db');
  fs.writeFileSync(old, 'x');
  fs.writeFileSync(fresh, 'x');
  fs.utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'));

  const removed = prune(outDir, 30, new Date('2026-09-25T12:00:00'));
  assert.deepEqual(removed, ['refillpal-20200101-0300.db']);
  assert.ok(fs.existsSync(fresh));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('数据库不存在时给出明确错误', () => {
  assert.throws(() => backup({ dbFile: '/tmp/definitely-not-here-xyz.db', outDir: '/tmp/x' }), /找不到数据库/);
});

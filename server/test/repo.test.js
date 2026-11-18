'use strict';

/**
 * Repository 测试：SQLite 实现必须与云数据库的语义一致，
 * 否则 handler 在两端的行为会不同。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSqliteRepo } = require('../src/db/sqlite-repo');

function fresh() {
  return createSqliteRepo({ file: ':memory:' });
}

test('add / get：写入后能按 _id 取回，且自动补 _id', async () => {
  const repo = fresh();
  const { _id } = await repo.collection('items').add({
    data: { familyId: 'f1', name: '抽纸', baseQty: 2, createdAt: new Date('2026-09-25T01:00:00.000Z') }
  });
  assert.ok(_id);
  assert.match(_id, /^items_/);

  const res = await repo.collection('items').where({ _id }).get();
  assert.equal(res.data.length, 1);
  assert.equal(res.data[0].name, '抽纸');
  assert.equal(res.data[0].baseQty, 2);
  repo.close();
});

test('日期字段读出来是 Date（与云数据库一致），不是字符串', async () => {
  const repo = fresh();
  const at = new Date('2026-09-25T01:00:00.000Z');
  await repo.collection('events').add({ data: { familyId: 'f1', occurredAt: at, qty: 1 } });

  const res = await repo.collection('events').where({ familyId: 'f1' }).get();
  assert.ok(res.data[0].occurredAt instanceof Date, 'occurredAt 应还原成 Date');
  assert.equal(res.data[0].occurredAt.getTime(), at.getTime());
  repo.close();
});

test('where：等值查询与 null', async () => {
  const repo = fresh();
  await repo.collection('items').add({ data: { familyId: 'f1', name: 'a', brand: null } });
  await repo.collection('items').add({ data: { familyId: 'f2', name: 'b', brand: 'x' } });

  assert.equal((await repo.collection('items').where({ familyId: 'f1' }).get()).data.length, 1);
  assert.equal((await repo.collection('items').where({ brand: null }).get()).data.length, 1);
  assert.equal((await repo.collection('items').where({ familyId: 'f1', name: 'a' }).get()).data.length, 1);
  assert.equal((await repo.collection('items').where({ familyId: 'nope' }).get()).data.length, 0);
  repo.close();
});

test('where：比较指令 gt/gte/lt/lte/in/nin', async () => {
  const repo = fresh();
  const c = repo.command;
  for (let i = 1; i <= 5; i += 1) {
    await repo.collection('items').add({ data: { n: i } });
  }

  assert.equal((await repo.collection('items').where({ n: c.gt(3) }).count()).total, 2);
  assert.equal((await repo.collection('items').where({ n: c.gte(3) }).count()).total, 3);
  assert.equal((await repo.collection('items').where({ n: c.lt(2) }).count()).total, 1);
  assert.equal((await repo.collection('items').where({ n: c.lte(2) }).count()).total, 2);
  assert.equal((await repo.collection('items').where({ n: c.in([1, 5]) }).count()).total, 2);
  assert.equal((await repo.collection('items').where({ n: c.nin([1, 5]) }).count()).total, 3);
  // 空数组不能生成 IN () 这种语法错误
  assert.equal((await repo.collection('items').where({ n: c.in([]) }).count()).total, 0);
  assert.equal((await repo.collection('items').where({ n: c.nin([]) }).count()).total, 5);
  repo.close();
});

test('orderBy / limit / skip：分页与排序', async () => {
  const repo = fresh();
  for (let i = 1; i <= 5; i += 1) {
    await repo.collection('events').add({
      data: { familyId: 'f1', n: i, occurredAt: new Date(Date.UTC(2026, 8, i)) }
    });
  }

  const desc = await repo.collection('events').where({ familyId: 'f1' }).orderBy('occurredAt', 'desc').get();
  assert.deepEqual(
    desc.data.map((d) => d.n),
    [5, 4, 3, 2, 1]
  );

  const page = await repo
    .collection('events')
    .where({ familyId: 'f1' })
    .orderBy('n', 'asc')
    .skip(2)
    .limit(2)
    .get();
  assert.deepEqual(
    page.data.map((d) => d.n),
    [3, 4]
  );
  repo.close();
});

test('update：普通字段与 inc 指令', async () => {
  const repo = fresh();
  const c = repo.command;
  const { _id } = await repo.collection('items').add({ data: { name: 'a', count: 5 } });

  await repo.collection('items').where({ _id }).update({ data: { name: 'b' } });
  assert.equal((await repo.collection('items').where({ _id }).get()).data[0].name, 'b');

  await repo.collection('items').where({ _id }).update({ data: { count: c.inc(3) } });
  assert.equal((await repo.collection('items').where({ _id }).get()).data[0].count, 8);

  // 嵌套对象整体替换
  await repo.collection('items').where({ _id }).update({ data: { meta: { a: 1 } } });
  assert.deepEqual((await repo.collection('items').where({ _id }).get()).data[0].meta, { a: 1 });
  repo.close();
});

test('remove：只删匹配的文档', async () => {
  const repo = fresh();
  await repo.collection('events').add({ data: { familyId: 'f1' } });
  await repo.collection('events').add({ data: { familyId: 'f2' } });

  const res = await repo.collection('events').where({ familyId: 'f1' }).remove();
  assert.equal(res.stats.removed, 1);
  assert.equal((await repo.collection('events').count()).total, 1);
  repo.close();
});

test('唯一索引：同一个 identityKey 不能加两次成员', async () => {
  const repo = fresh();
  await repo.collection('members').add({ data: { identityKey: 'user:1', familyId: 'f1' } });
  await assert.rejects(() =>
    repo.collection('members').add({ data: { identityKey: 'user:1', familyId: 'f2' } })
  );
  repo.close();
});

test('唯一索引：email 唯一，但 null 允许重复', async () => {
  const repo = fresh();
  await repo.collection('users').add({ data: { email: 'a@b.com' } });
  await assert.rejects(() => repo.collection('users').add({ data: { email: 'a@b.com' } }));

  await repo.collection('users').add({ data: { wechatOpenid: 'o1' } });
  await repo.collection('users').add({ data: { wechatOpenid: 'o2' } });
  assert.equal((await repo.collection('users').count()).total, 3);
  repo.close();
});

test('集合之间互不干扰', async () => {
  const repo = fresh();
  await repo.collection('items').add({ data: { name: '同名' } });
  await repo.collection('events').add({ data: { name: '同名' } });
  assert.equal((await repo.collection('items').count()).total, 1);
  assert.equal((await repo.collection('events').count()).total, 1);
  repo.close();
});

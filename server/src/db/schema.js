'use strict';

/**
 * 建表 DDL（幂等）。
 *
 * 只用一个 `docs` 表存所有集合：`collection + id` 是主键，`doc` 是 JSON。
 *
 * 为什么不做强类型表：
 *   1. 数据模型本来就是文档型（events 字段可变、settings 是嵌套对象）；
 *   2. 现有 handler 是按「document in / document out」写的，强类型表需要一层
 *      30 多列的映射与类型转换，换来的收益在这个数据量下为零；
 *   3. 换 Postgres 时可以直接映射成 jsonb，不需要为每个新字段写迁移。
 *
 * 需要范围/排序的地方用表达式索引补齐（见下）。
 */

const DDL = `
CREATE TABLE IF NOT EXISTS docs (
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  doc        TEXT NOT NULL,
  PRIMARY KEY (collection, id)
);

CREATE INDEX IF NOT EXISTS docs_by_collection ON docs(collection);

-- 热路径：按家庭取物品
CREATE INDEX IF NOT EXISTS items_by_family
  ON docs(collection, json_extract(doc, '$.familyId'))
  WHERE collection = 'items';

-- 热路径：按家庭取流水，按发生时间倒序
CREATE INDEX IF NOT EXISTS events_by_family_time
  ON docs(collection, json_extract(doc, '$.familyId'), json_extract(doc, '$.occurredAt') DESC)
  WHERE collection = 'events';

-- 热路径：按家庭取成员
CREATE INDEX IF NOT EXISTS members_by_family
  ON docs(collection, json_extract(doc, '$.familyId'))
  WHERE collection = 'members';

-- 唯一约束（用部分索引实现，缺失字段时自然允许多行）
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
  ON docs(json_extract(doc, '$.email'))
  WHERE collection = 'users' AND json_extract(doc, '$.email') IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS members_identity_unique
  ON docs(json_extract(doc, '$.identityKey'))
  WHERE collection = 'members' AND json_extract(doc, '$.identityKey') IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS families_invite_unique
  ON docs(json_extract(doc, '$.inviteCode'))
  WHERE collection = 'families' AND json_extract(doc, '$.inviteCode') IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS pushlogs_day_unique
  ON docs(json_extract(doc, '$.familyId'), json_extract(doc, '$.date'))
  WHERE collection = 'pushLogs';
`;

/** 逻辑集合名（与云开发里的集合一一对应） */
const COLLECTIONS = ['families', 'members', 'items', 'events', 'users', 'pushLogs'];

module.exports = { DDL, COLLECTIONS };

'use strict';

/**
 * SQLite 版 Repository —— 实现与微信云数据库同名的那套链式 API：
 *
 *   collection(name).where(cond).orderBy(f, dir).limit(n).skip(n)
 *     .get() / .count() / .add({data}) / .update({data}) / .remove()
 *   command: eq / neq / gt / gte / lt / lte / in / nin / inc
 *
 * 这样 packages/refillpal-core 里的 handler 一行都不用改就能跑在 SQLite 上。
 * 测试里的 test-utils/fake-db.js 是同一套接口的第三个实现。
 *
 * 存储用「通用文档表」：一个 docs 表存所有集合，doc 是 JSON。
 * 选择它而不是给每个集合建强类型表，是因为数据模型本来就是文档型的
 * （events 字段可变、settings 是嵌套对象），而且换 Postgres 时可以直接
 * 映射成 jsonb，不需要为每个新字段写迁移。
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

/** 会把形如 2026-09-25T01:00:00.000Z 的字符串还原成 Date，保持与云数据库一致 */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function bind(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/** 递归还原日期字段（只处理键名以 At/Date 结尾的字符串，避免误伤备注里的日期） */
function rehydrate(value, keyHint) {
  if (typeof value === 'string') {
    if (ISO_RE.test(value) && /(At|Date)$/.test(keyHint || '')) return new Date(value);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => rehydrate(v, keyHint));
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach((k) => {
      out[k] = rehydrate(value[k], k);
    });
    return out;
  }
  return value;
}

const COMMANDS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'inc'];

function createCommand() {
  const command = {};
  COMMANDS.forEach((op) => {
    command[op] = (value) => ({ __op: op, value });
  });
  return command;
}

function isCommand(v) {
  return Boolean(v && typeof v === 'object' && typeof v.__op === 'string' && COMMANDS.indexOf(v.__op) >= 0);
}

const FIELD_OPS = {
  eq: '=',
  neq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<='
};

function fieldExpr(key) {
  // _id 落在真实列上，能走主键索引
  if (key === '_id' || key === 'id') return 'id';
  return `json_extract(doc, '$.${key.replace(/'/g, "''")}')`;
}

function buildWhere(cond) {
  const clauses = [];
  const params = [];

  Object.keys(cond || {}).forEach((key) => {
    const value = cond[key];
    const expr = fieldExpr(key);

    if (isCommand(value)) {
      if (value.__op === 'in' || value.__op === 'nin') {
        const list = value.value || [];
        if (!list.length) {
          // IN () 是语法错误；用恒假/恒真代替
          clauses.push(value.__op === 'in' ? '0 = 1' : '1 = 1');
          return;
        }
        const holes = list.map(() => '?').join(', ');
        clauses.push(`${expr} ${value.__op === 'in' ? 'IN' : 'NOT IN'} (${holes})`);
        list.forEach((v) => params.push(bind(v)));
        return;
      }
      const op = FIELD_OPS[value.__op];
      if (!op) throw new Error(`SQLite repository 不支持在 where 中使用 ${value.__op}`);
      clauses.push(`${expr} ${op} ?`);
      params.push(bind(value.value));
      return;
    }

    if (value === null || value === undefined) {
      clauses.push(`${expr} IS NULL`);
      return;
    }
    clauses.push(`${expr} = ?`);
    params.push(bind(value));
  });

  return {
    sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '',
    params
  };
}

function buildOrder(order) {
  if (!order || !order.length) return '';
  const parts = order.map(({ field, dir }) => `${fieldExpr(field)} ${dir === 'desc' ? 'DESC' : 'ASC'}`);
  return ` ORDER BY ${parts.join(', ')}`;
}

function buildSet(data) {
  const sets = [];
  const params = [];
  Object.keys(data || {}).forEach((key) => {
    const value = data[key];
    const jsonPath = `'$.${key.replace(/'/g, "''")}'`;
    if (isCommand(value) && value.__op === 'inc') {
      sets.push(`doc = json_set(doc, ${jsonPath}, COALESCE(json_extract(doc, ${jsonPath}), 0) + ?)`);
      params.push(Number(value.value) || 0);
      return;
    }
    sets.push(`doc = json_set(doc, ${jsonPath}, json(?))`);
    params.push(JSON.stringify(value === undefined ? null : value));
  });
  return { sql: sets.join(', '), params };
}

function createSqliteRepo(options = {}) {
  const file = options.file || ':memory:';
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');

  const schema = options.schema || require('./schema');
  db.exec(schema.DDL);

  let idSeq = 0;
  function nextId(collection) {
    idSeq += 1;
    return `${collection}_${Date.now().toString(36)}${idSeq.toString(36).padStart(3, '0')}`;
  }

  function collection(name) {
    return buildQuery(name, { cond: {}, order: [], limit: null, skip: 0 });
  }

  function buildQuery(name, state) {
    const whereSql = buildWhere(state.cond);

    const api = {
      where(cond) {
        return buildQuery(name, Object.assign({}, state, { cond: Object.assign({}, state.cond, cond || {}) }));
      },
      orderBy(field, dir) {
        return buildQuery(name, Object.assign({}, state, { order: state.order.concat([{ field, dir }]) }));
      },
      limit(n) {
        return buildQuery(name, Object.assign({}, state, { limit: Number(n) }));
      },
      skip(n) {
        return buildQuery(name, Object.assign({}, state, { skip: Number(n) }));
      },

      async get() {
        let sql = `SELECT doc FROM docs WHERE collection = ?${whereSql.sql.replace(/^ WHERE /, ' AND ')}`;
        const params = [name].concat(whereSql.params);
        sql += buildOrder(state.order);
        if (state.limit !== null && Number.isFinite(state.limit)) {
          sql += ` LIMIT ${Math.max(0, Math.trunc(state.limit))}`;
        } else {
          sql += ' LIMIT -1';
        }
        if (state.skip) sql += ` OFFSET ${Math.max(0, Math.trunc(state.skip))}`;

        const rows = db.prepare(sql).all(...params);
        return { data: rows.map((r) => rehydrate(JSON.parse(r.doc), 'doc')) };
      },

      async count() {
        const sql = `SELECT COUNT(*) AS n FROM docs WHERE collection = ?${whereSql.sql.replace(/^ WHERE /, ' AND ')}`;
        const row = db.prepare(sql).get(name, ...whereSql.params);
        return { total: row ? Number(row.n) : 0 };
      },

      async add({ data } = {}) {
        const doc = Object.assign({}, data || {});
        const id = doc._id || nextId(name);
        doc._id = id;
        db.prepare('INSERT INTO docs (collection, id, doc) VALUES (?, ?, ?)').run(
          name,
          id,
          JSON.stringify(serialize(doc))
        );
        return { _id: id };
      },

      async update({ data } = {}) {
        const set = buildSet(data || {});
        if (!set.sql) return { stats: { updated: 0 } };
        const sql = `UPDATE docs SET ${set.sql} WHERE collection = ?${whereSql.sql.replace(/^ WHERE /, ' AND ')}`;
        const info = db.prepare(sql).run(...set.params, name, ...whereSql.params);
        return { stats: { updated: Number(info.changes) } };
      },

      async remove() {
        const sql = `DELETE FROM docs WHERE collection = ?${whereSql.sql.replace(/^ WHERE /, ' AND ')}`;
        const info = db.prepare(sql).run(name, ...whereSql.params);
        return { stats: { removed: Number(info.changes) } };
      }
    };

    return api;
  }

  return {
    collection,
    command: createCommand(),
    /** 直接执行 SQL，迁移与测试用 */
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    close: () => db.close(),
    file
  };
}

/** 写入前把 Date 统一转成 ISO 字符串，和云数据库返回的形态一致 */
function serialize(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach((k) => {
      out[k] = serialize(value[k]);
    });
    return out;
  }
  return value;
}

module.exports = { createSqliteRepo, rehydrate, serialize, buildWhere, bind, isCommand };
